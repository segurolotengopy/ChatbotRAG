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
 *   4. con el perfil `pruebas` del entorno y `conocimiento.paquete.habilitado`, carga el paquete no validado
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
  BitacoraConsola,
  cargarConfiguracionDesdeJson,
  cargarCorpus,
  cargarPaqueteKuaa,
  coleccionDe,
  type LectorPaquete,
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
import { ErrorPaqueteGcs, LectorPaqueteGcs } from '@chatbotrag/conocimiento-gcs';
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

export async function armarAgentes(
  entorno: Entorno,
  opciones: { bitacora?: Bitacora; fabricas?: FabricasNube; ejecutorExterno?: EjecutorHerramientas | null; pool?: ReturnType<typeof crearPool>; lectorPaquete?: (entorno: Entorno) => LectorPaquete } = {},
): Promise<Map<string, AgenteArmado>> {
  const bitacora = opciones.bitacora ?? new BitacoraConsola();
  const fabricas = opciones.fabricas ?? FABRICAS_REALES;
  const dir = resolve(entorno.CHATBOTRAG_DIR_CONFIGURACIONES);
  const archivos = (await readdir(dir)).filter((a) => a.endsWith('.json') && !a.endsWith('.local.json'));
  if (archivos.length === 0) throw new Error(`No hay configuraciones *.json en ${dir}`);

  const pool = entorno.CHATBOTRAG_INDICE === 'pgvector' ? (opciones.pool ?? crearPool({ connectionString: entorno.PGVECTOR_URL })) : null;
  const lector = { leer: (ruta: string) => readFile(join(dir, 'corpus', ruta), 'utf8') };
  const agentes = new Map<string, AgenteArmado>();

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
    if (agentes.has(config.id)) throw new Error(`Id de agente duplicado: ${config.id} (${archivo})`);

    const nube = elegirNube(config, entorno, fabricas);
    const indice: IndiceConocimiento = pool ? new IndicePgvector(pool, nube.embebedor) : new IndiceEnMemoria(nube.embebedor);
    await cargarCorpus(config, lector, indice, bitacora);

    // Paquete no validado: SOLO con perfil `pruebas`. Con `produccion` ni se construye el lector.
    let versionPaquete: string | null = null;
    let fragmentosPaquete = 0;
    if (entorno.perfilConocimiento === 'pruebas' && config.conocimiento.paquete.habilitado) {
      const coleccion = coleccionDe(config, null);
      const baseEvento = { agenteId: config.id, perfilId: null, conversacionHash: '-', canal: '-' };
      try {
        const lectorPaquete = (opciones.lectorPaquete ?? crearLectorPaqueteGcs)(entorno);
        const r = await cargarPaqueteKuaa(lectorPaquete, 'pruebas', indice, coleccion, { agenteId: config.id, versionEsperada: entorno.CHATBOTRAG_VERSION_PAQUETE ?? '', tamano: config.conocimiento.tamanoFragmento, solapamiento: config.conocimiento.solapamiento }, bitacora);
        versionPaquete = r.version;
        fragmentosPaquete = r.fragmentos;
      } catch (e) {
        // Se arranca igual, sin fragmentos del paquete: Kuaa responde «sin respaldo». Solo el código, jamás el detalle.
        try {
          await indice.vaciar(coleccion);
        } catch {
          // El índice en memoria no falla; si otro índice falla, el evento de abajo ya deja constancia.
        }
        bitacora.registrar({ ...baseEvento, tipo: 'paquete_no_cargado', codigo: e instanceof ErrorPaqueteGcs ? e.codigo : 'ERROR' });
      }
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
    const agenteKuaa = config.tipoAgente === 'kuaa' ? new AgenteKuaa(dependencias, { perfilConocimiento: entorno.perfilConocimiento }) : undefined;
    agentes.set(config.id, { config, agente, ...(agenteKuaa ? { agenteKuaa } : {}), memoria, indice, proveedor: nube.proveedor.nombre, perfilConocimiento: entorno.perfilConocimiento, versionPaquete });
    bitacora.registrar({ tipo: 'configuracion_cargada', agenteId: config.id, perfilId: null, conversacionHash: '-', canal: '-', detalle: `archivo=${archivo} proveedor=${nube.proveedor.nombre} indice=${indice.nombre} perfiles=${Object.keys(config.perfiles).length} perfil_conocimiento=${entorno.perfilConocimiento} paquete=${versionPaquete ?? 'ninguno'} fragmentos_paquete=${fragmentosPaquete}` });
  }
  return agentes;
}
