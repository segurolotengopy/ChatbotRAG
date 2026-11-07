/**
 * ARMADO DE LOS AGENTES — composition root del servicio
 *
 * Es el único lugar que conoce a la vez el núcleo, los adaptadores de nube y el
 * índice persistente. Por cada `*.json` del directorio de configuraciones:
 *
 *   1. valida la configuración (esquema, secretos, herramientas declaradas);
 *   2. elige el proveedor LLM y el embebedor según `modelo.proveedor`
 *      (o el forzado por entorno, para desarrollo sin nube);
 *   3. elige el índice (memoria o pgvector) y carga el corpus público;
 *   4. con el perfil `pruebas` del entorno, un agente `kuaa` con `conocimiento.paquete.habilitado` y un índice
 *      que no sea pgvector, carga el paquete no validado
 *      desde su bucket privado (si falla, el agente arranca con 0 fragmentos de paquete: «sin respaldo»);
 *   5. construye el `Agente`.
 *
 * Un archivo inválido detiene el arranque con el detalle: un servicio que arranca
 * con un agente a medias atiende mal en silencio, que es peor que no arrancar.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  Agente,
  AgenteKuaa,
  EmbebedorConMemoria,
  type IndiceSemantico,
  prepararIndiceSemantico,
  causaDeError,
  BitacoraConsola,
  cargarConfiguracionDesdeJson,
  cargarCorpus,
  cargarPaqueteKuaa,
  coleccionPaquete,
  coleccionDe,
  type LectorPaquete,
  type OpcionesEnrutadorKuaa,
  type ConfiguracionAgente,
  type Embebedor,
  ErrorConfiguracion,
  IndiceEnMemoria,
  type IndiceConocimiento,
  MemoriaEnProceso,
  type ProveedorLLM,
  ProveedorSimulado,
  RegistroHerramientas,
  validarHerramientas,
  type Bitacora,
  type EjecutorHerramientas,
} from '@chatbotrag/nucleo';
import { crearClienteVertex, EmbebedorVertex, ProveedorVertex } from '@chatbotrag/proveedor-vertex';
import { crearClienteBedrock, EmbebedorBedrock, ProveedorBedrock } from '@chatbotrag/proveedor-bedrock';
import { crearPool, IndicePgvector } from '@chatbotrag/conocimiento-pgvector';
import { ErrorPaqueteGcs, LectorBancoGcs, LectorPaqueteGcs, type DeclaracionBanco, type ResultadoBancoGcs } from '@chatbotrag/conocimiento-gcs';
import type { Entorno } from './entorno.js';

export interface AgenteArmado {
  config: ConfiguracionAgente;
  agente: Agente;
  /** Solo en agentes con `tipoAgente: 'kuaa'`; atiende la ruta provisional `/v1/kuaa/mensaje`. */
  agenteKuaa?: AgenteKuaa;
  memoria: MemoriaEnProceso;
  indice: IndiceConocimiento;
  proveedor: string;
  /** Perfil del conocimiento con que se armó (del entorno). */
  perfilConocimiento: 'produccion' | 'pruebas';
  /** Versión del paquete no validado cargado; `null` si no se cargó (siempre `null` con `produccion`). */
  versionPaquete: string | null;
  /**
   * Resultado de la carga del banco desde el bucket (H4c), o `null` si el agente no tiene banco declarado. El agente solo lo
   * usa si `CHATBOTRAG_ENRUTADOR` lo enciende (H4d). `indice` es `null` si el banco no se pudo cargar.
   */
  enrutadorBanco: ResultadoBancoGcs | null;
}

/** Costura de inyección del lector del banco (pruebas sin red). */
export interface LectorBanco {
  cargar(agenteId: string, declaracion: DeclaracionBanco, opciones: { admitirSintetico: boolean }): Promise<ResultadoBancoGcs>;
}

export interface FabricasNube {
  vertex(entorno: Entorno, modeloEmbeddings: string | undefined): { proveedor: ProveedorLLM; embebedor: Embebedor };
  bedrock(entorno: Entorno, modeloEmbeddings: string | undefined): { proveedor: ProveedorLLM; embebedor: Embebedor };
}

export const FABRICAS_REALES: FabricasNube = {
  vertex(entorno, modeloEmbeddings) {
    if (!entorno.GCP_PROYECTO) throw new Error('Un agente con proveedor vertex exige GCP_PROYECTO en el entorno');
    const cliente = crearClienteVertex({ proyecto: entorno.GCP_PROYECTO, region: entorno.GCP_REGION });
    return { proveedor: new ProveedorVertex(cliente), embebedor: new EmbebedorVertex(cliente, modeloEmbeddings ? { modelo: modeloEmbeddings } : {}) };
  },
  bedrock(entorno, modeloEmbeddings) {
    const cliente = crearClienteBedrock(entorno.AWS_REGION);
    return { proveedor: new ProveedorBedrock(cliente), embebedor: new EmbebedorBedrock(cliente, modeloEmbeddings ? { modelo: modeloEmbeddings } : {}) };
  },
};

function elegirNube(config: ConfiguracionAgente, entorno: Entorno, fabricas: FabricasNube): { proveedor: ProveedorLLM; embebedor: Embebedor | null } {
  const forzado = entorno.CHATBOTRAG_PROVEEDOR_FORZADO;
  const proveedor = forzado ?? config.modelo.proveedor;
  switch (proveedor) {
    case 'simulado':
      // Sin embeddings: el índice en memoria funciona solo con la señal léxica.
      return { proveedor: new ProveedorSimulado(), embebedor: null };
    case 'vertex':
      return fabricas.vertex(entorno, config.modelo.modeloEmbeddings);
    case 'bedrock':
      return fabricas.bedrock(entorno, config.modelo.modeloEmbeddings);
    default:
      throw new Error(`Proveedor no soportado: ${String(proveedor)}`);
  }
}

function crearLectorPaqueteGcs(entorno: Entorno): LectorPaquete {
  // `leerEntorno` garantiza que con perfil `pruebas` ambas variables existen.
  return new LectorPaqueteGcs({ bucket: entorno.CHATBOTRAG_BUCKET_PAQUETE ?? '', version: entorno.CHATBOTRAG_VERSION_PAQUETE ?? '' });
}

/** Tiempo máximo por defecto de la carga del banco de un agente: una llamada a GCS colgada no debe colgar el arranque. */
const TIEMPO_BANCO_MS = 10_000;

/** Espera antes del único reintento del índice semántico ante cuota o saturación (inyectable en pruebas). */
const ESPERA_REINTENTO_SEMANTICA_MS = 2000;

const esperarPorDefecto = (ms: number): Promise<void> => new Promise((resolver) => setTimeout(resolver, ms));

class TiempoAgotado extends Error {}

/**
 * Prepara el índice semántico con UN reintento tras una espera si el embebedor falló por cuota o saturación (una ráfaga de
 * arranques en frío puede toparse con el límite). Todo dentro del tope de tiempo que aplica quien llama. Cada instancia lo
 * prepara por su cuenta: el costo es un lote de embeddings (uno por pregunta del banco) por arranque en frío.
 */
async function prepararSemanticaConReintento(banco: Parameters<typeof prepararIndiceSemantico>[0], embebedor: Embebedor, esperar: (ms: number) => Promise<void>): Promise<IndiceSemantico> {
  try {
    return await prepararIndiceSemantico(banco, embebedor);
  } catch (e) {
    const causa = causaDeError(e);
    if (causa !== 'cuota' && causa !== 'saturacion') throw e;
    await esperar(ESPERA_REINTENTO_SEMANTICA_MS);
    return prepararIndiceSemantico(banco, embebedor);
  }
}

function conTiempoLimite<T>(promesa: Promise<T>, ms: number): Promise<T> {
  let temporizador: NodeJS.Timeout | undefined;
  const limite = new Promise<never>((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(new TiempoAgotado('tiempo agotado')), ms);
  });
  // Si la carga termina después del límite, su rechazo tardío no debe quedar sin atender.
  promesa.catch(() => undefined);
  return Promise.race([promesa, limite]).finally(() => clearTimeout(temporizador));
}

function crearLectorBancoGcs(entorno: Entorno): LectorBanco {
  // `leerEntorno` garantiza que con bancos declarados el bucket existe.
  return new LectorBancoGcs({ bucket: entorno.CHATBOTRAG_BUCKET_BANCO ?? '' });
}

export async function armarAgentes(
  entorno: Entorno,
  opciones: { bitacora?: Bitacora; fabricas?: FabricasNube; ejecutorExterno?: EjecutorHerramientas | null; pool?: ReturnType<typeof crearPool>; lectorPaquete?: (entorno: Entorno) => LectorPaquete; lectorBanco?: (entorno: Entorno) => LectorBanco; tiempoBancoMs?: number; esperar?: (ms: number) => Promise<void> } = {},
): Promise<Map<string, AgenteArmado>> {
  const bitacora = opciones.bitacora ?? new BitacoraConsola();
  const fabricas = opciones.fabricas ?? FABRICAS_REALES;
  const dir = resolve(entorno.CHATBOTRAG_DIR_CONFIGURACIONES);
  const archivos = (await readdir(dir)).filter((a) => a.endsWith('.json') && !a.endsWith('.local.json'));
  if (archivos.length === 0) throw new Error(`No hay configuraciones *.json en ${dir}`);

  const pool = entorno.CHATBOTRAG_INDICE === 'pgvector' ? (opciones.pool ?? crearPool({ connectionString: entorno.PGVECTOR_URL })) : null;
  const lector = { leer: (ruta: string) => readFile(join(dir, 'corpus', ruta), 'utf8') };
  const agentes = new Map<string, AgenteArmado>();

  // Primera pasada: se leen y validan TODAS las configuraciones y se comprueba que cada agente de CHATBOTRAG_BANCOS exista,
  // antes de gastar una sola lectura del bucket o de emitir un evento en un arranque que va a fallar.
  const configuraciones: Array<{ archivo: string; config: ConfiguracionAgente }> = [];
  const idsConfigurados = new Set<string>();
  for (const archivo of archivos) {
    let config: ConfiguracionAgente;
    try {
      config = cargarConfiguracionDesdeJson(await readFile(join(dir, archivo), 'utf8'));
    } catch (e) {
      const detalle = e instanceof ErrorConfiguracion ? e.detalles.join('; ') : String(e);
      throw new Error(`Configuración inválida en ${archivo}: ${detalle}`);
    }
    const problemas = validarHerramientas(config);
    if (problemas.length) throw new Error(`Herramientas inválidas en ${archivo}: ${problemas.join('; ')}`);
    if (idsConfigurados.has(config.id)) throw new Error(`Id de agente duplicado: ${config.id} (${archivo})`);
    idsConfigurados.add(config.id);
    configuraciones.push({ archivo, config });
  }
  const huerfanos = Object.keys(entorno.bancos).filter((id) => !idsConfigurados.has(id));
  if (huerfanos.length > 0) throw new Error(`CHATBOTRAG_BANCOS declara agentes inexistentes: ${huerfanos.join(', ')}`);

  // Segunda pasada: armado de cada agente.
  for (const { archivo, config } of configuraciones) {
    const nube = elegirNube(config, entorno, fabricas);
    // Enrutador híbrido (H4d): solo si la variable lo enciende, la configuración lo declara activo y hay banco declarado.
    // Entonces el RAG y el enrutador comparten UN embebedor con memoria (una llamada de embedding por mensaje). Sin la variable
    // no se construye nada nuevo.
    const enrutadorSolicitado = entorno.enrutador !== 'apagado' && config.tipoAgente === 'kuaa' && config.enrutador.activo && Object.hasOwn(entorno.bancos, config.id);
    const embebedorCompartido: Embebedor | null = enrutadorSolicitado && nube.embebedor ? new EmbebedorConMemoria(nube.embebedor) : nube.embebedor;
    const indice: IndiceConocimiento = pool ? new IndicePgvector(pool, embebedorCompartido) : new IndiceEnMemoria(embebedorCompartido);
    await cargarCorpus(config, lector, indice, bitacora);

    // Paquete no validado: SOLO Kuaa, SOLO con perfil `pruebas`, y nunca sobre pgvector (la vía de producción).
    // Con `produccion` ni se construye el lector.
    let versionPaquete: string | null = null;
    let fragmentosPaquete = 0;
    if (entorno.perfilConocimiento === 'pruebas' && config.tipoAgente === 'kuaa' && config.conocimiento.paquete.habilitado) {
      const coleccion = coleccionDe(config, null);
      const baseEvento = { agenteId: config.id, perfilId: null, conversacionHash: '-', canal: '-' };
      if (pool) {
        bitacora.registrar({ ...baseEvento, tipo: 'paquete_no_cargado', codigo: 'PGVECTOR_NO_ADMITE' });
      } else {
        try {
          const lectorPaquete = (opciones.lectorPaquete ?? crearLectorPaqueteGcs)(entorno);
          const r = await cargarPaqueteKuaa(lectorPaquete, 'pruebas', indice, coleccion, { agenteId: config.id, versionEsperada: entorno.CHATBOTRAG_VERSION_PAQUETE ?? '', tamano: config.conocimiento.tamanoFragmento, solapamiento: config.conocimiento.solapamiento }, bitacora);
          versionPaquete = r.version;
          fragmentosPaquete = r.fragmentos;
        } catch (e) {
          // Se arranca igual, sin fragmentos del paquete: Kuaa responde «sin respaldo». Solo el código, jamás el detalle.
          // Se vacía ÚNICAMENTE la colección del paquete: el corpus público (colección base) no se toca.
          try {
            await indice.vaciar(coleccionPaquete(coleccion));
          } catch {
            // Sin más recurso: el evento de abajo deja constancia.
          }
          bitacora.registrar({ ...baseEvento, tipo: 'paquete_no_cargado', codigo: e instanceof ErrorPaqueteGcs ? e.codigo : 'ERROR' });
        }
      }
    }

    // Banco aprobado (H4c): solo si hay declaración para este agente. Nunca lanza ni cambia al agente.
    let enrutadorBanco: ResultadoBancoGcs | null = null;
    let opcionesEnrutador: OpcionesEnrutadorKuaa | undefined;
    // `hasOwn`: un agente llamado `constructor` no debe heredar propiedades del prototipo.
    const declaracionBanco = Object.hasOwn(entorno.bancos, config.id) ? entorno.bancos[config.id] : undefined;
    if (declaracionBanco) {
      const baseEvento = { agenteId: config.id, perfilId: null, conversacionHash: '-', canal: '-' };
      try {
        const lectorBanco = (opciones.lectorBanco ?? crearLectorBancoGcs)(entorno);
        enrutadorBanco = await conTiempoLimite(lectorBanco.cargar(config.id, declaracionBanco, { admitirSintetico: (entorno.APP_ENV ?? '').trim().toLowerCase() === 'test' }), opciones.tiempoBancoMs ?? TIEMPO_BANCO_MS);
      } catch (e) {
        enrutadorBanco = { indice: null, calibracion: null, motivo: e instanceof TiempoAgotado ? 'banco_tiempo' : 'banco_error' };
      }
      // Índice semántico (H4d): cuesta un embedding por pregunta del banco, una sola vez al arrancar. Sin calibración o sin
      // embebedor no hay semántica que preparar. Un fallo o un tiempo vencido no detiene el arranque: sin semántica.
      let indiceSemantico: IndiceSemantico | null = null;
      if (enrutadorSolicitado && enrutadorBanco.indice !== null && enrutadorBanco.calibracion !== null && nube.embebedor !== null) {
        try {
          indiceSemantico = await conTiempoLimite(prepararSemanticaConReintento(enrutadorBanco.indice.banco, nube.embebedor, opciones.esperar ?? esperarPorDefecto), opciones.tiempoBancoMs ?? TIEMPO_BANCO_MS);
        } catch {
          indiceSemantico = null;
        }
      }
      if (enrutadorSolicitado && enrutadorBanco.indice !== null) {
        opcionesEnrutador = {
          modo: entorno.enrutador === 'activo_fijo' ? 'activo_fijo' : 'activo',
          indice: enrutadorBanco.indice,
          calibracion: enrutadorBanco.calibracion,
          indiceSemantico,
          embebedor: embebedorCompartido,
          admitirSimulado: (entorno.APP_ENV ?? '').trim().toLowerCase() === 'test',
        };
      }
      // Solo enumerados: ni rutas ni texto del banco ni de las derivaciones.
      const cargado = enrutadorBanco.indice !== null;
      const marcaSemantica = enrutadorSolicitado ? ` semantica=${indiceSemantico ? 'si' : 'no'} enrutador=${entorno.enrutador}` : '';
      bitacora.registrar({ ...baseEvento, tipo: cargado ? 'banco_cargado' : 'banco_no_cargado', codigo: enrutadorBanco.motivo ?? 'ok', detalle: `calibracion=${enrutadorBanco.calibracion ? 'si' : 'no'}${marcaSemantica}` });
    }

    const memoria = new MemoriaEnProceso();
    const dependencias = {
      config,
      proveedor: nube.proveedor,
      indice,
      memoria,
      herramientas: new RegistroHerramientas(opciones.ejecutorExterno ?? null),
      bitacora,
    };
    const agente = new Agente(dependencias);
    const agenteKuaa = config.tipoAgente === 'kuaa' ? new AgenteKuaa(dependencias, { perfilConocimiento: entorno.perfilConocimiento, versionPaquete, enrutador: opcionesEnrutador }) : undefined;
    agentes.set(config.id, { config, agente, ...(agenteKuaa ? { agenteKuaa } : {}), memoria, indice, proveedor: nube.proveedor.nombre, perfilConocimiento: entorno.perfilConocimiento, versionPaquete, enrutadorBanco });
    bitacora.registrar({ tipo: 'configuracion_cargada', agenteId: config.id, perfilId: null, conversacionHash: '-', canal: '-', detalle: `archivo=${archivo} proveedor=${nube.proveedor.nombre} indice=${indice.nombre} perfiles=${Object.keys(config.perfiles).length} perfil_conocimiento=${entorno.perfilConocimiento} paquete=${versionPaquete ?? 'ninguno'} fragmentos_paquete=${fragmentosPaquete}` });
  }
  return agentes;
}
