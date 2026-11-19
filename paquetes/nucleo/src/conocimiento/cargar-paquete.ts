/**
 * CARGA DEL PAQUETE DE CONOCIMIENTO DE KUAA (perfil `pruebas`)
 *
 * Porqué: el paquete de conocimiento de Kuaa todavía no lo revisó nadie. Para probarlo en staging se
 * carga marcado `no_validado` y con su versión, y se vuelve visible en cada respuesta que lo usa. Esta
 * función es pura respecto de la nube: recibe un `LectorPaquete` (el adaptador de GCS vive en
 * `paquetes/conocimiento-gcs`), así que el núcleo no importa ningún SDK.
 *
 * COLECCIÓN PROPIA: los fragmentos del paquete van a `<coleccion>--paquete`, nunca a la colección base: así
 * un fallo vacía solo lo no validado y el corpus público queda intacto. SOLO se aceptan registros
 * `no_validado`: uno `habilitado_produccion:true` dentro del paquete es un error de origen y se rechaza. Se
 * acumula todo y se indexa UNA vez, después de validar todos los archivos.
 *
 * Defensa: TODO registro pasa por `separarRegistrosHabilitados(…, perfil)`, también los documentos de texto
 * (se envuelven como un registro `habilitado_produccion:false` + `validacion:"no_validado"`). Con perfil
 * `produccion` el validador rechaza los no validados; y como segunda barrera, si algún fragmento con marca
 * llegara a producirse bajo ese perfil, la función lanza ANTES de indexar. Falla cerrado.
 *
 * Una forma desconocida, un archivo que no es JSON o una extensión no admitida se cuentan como rechazos
 * y no abortan la carga; un manifiesto inválido o de otra versión sí la aborta. Los eventos de bitácora
 * llevan solo conteos y códigos, jamás contenido.
 *
 * PAQUETE VALIDADO (`cargarPaqueteValidado`, S2-A): es la vía de producción para el contenido que Rodrigo ya validó.
 * No cambia el sentido de `cargarPaqueteKuaa`: es una función aparte, con perfil `produccion` fijo. Solo admite
 * archivos `.json`: un `.md` o un JSON ilegible ABORTAN la carga (error con la ruta, jamás el texto), porque un
 * paquete validado con un archivo ajeno o dañado no es el que Rodrigo aprobó. Un registro individual no habilitado
 * sigue contando como rechazado (y va al contador de la bitácora). Un registro entra solo
 * si pasa `separarRegistrosHabilitados(…, 'produccion')`, su `version_paquete` coincide con la del manifiesto y NO
 * trae `validacion`. Los fragmentos se indexan SIN marcas (`validacion` ni `versionPaquete`) en la colección del
 * paquete; así el agente los trata como conocimiento habilitado. Cero fragmentos es un error («paquete validado
 * vacío»): un paquete vacío no debe pasar por una carga correcta. Se indexa una sola vez, tras validar todo.
 *
 * Qué NO garantiza: la veracidad ni la titularidad del contenido; ni la integridad de los archivos (la
 * verifica el lector, con el SHA-256 del manifiesto).
 */
import { z } from 'zod';
import type { Bitacora } from '../puertos/bitacora.js';
import type { Fragmento, IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import { quitarComentariosHtml } from './cargar-corpus.js';
import { separarRegistrosHabilitados, type PerfilValidacion, type RegistroNoValidado, type RegistroPlano } from './registros-habilitados.js';
import { trocear } from './trocear.js';

export const TOPE_BYTES_ARCHIVO = 5 * 1024 * 1024;
export const TOPE_BYTES_PAQUETE = 50 * 1024 * 1024;
export const TOPE_ARCHIVOS_PAQUETE = 200;

export const esquemaManifiestoPaquete = z
  .object({
    version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
    archivos: z
      .array(
        z.object({
          ruta: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/).max(200),
          titular: z.enum(['interseguros', 'alianza']),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          bytes: z.number().int().min(0).max(TOPE_BYTES_ARCHIVO),
        }),
      )
      .max(TOPE_ARCHIVOS_PAQUETE),
  })
  .superRefine((m, ctx) => {
    if (new Set(m.archivos.map((a) => a.ruta)).size !== m.archivos.length) ctx.addIssue({ code: 'custom', message: 'rutas duplicadas' });
    if (m.archivos.reduce((t, a) => t + a.bytes, 0) > TOPE_BYTES_PAQUETE) ctx.addIssue({ code: 'custom', message: 'el paquete supera el tope de tamaño' });
  });

export type ManifiestoPaquete = z.infer<typeof esquemaManifiestoPaquete>;

/** Origen del paquete: el manifiesto y cada archivo como texto. Verifica la integridad quien lo implementa. */
export interface LectorPaquete {
  leerManifiesto(): Promise<unknown>;
  leer(rutaRelativa: string): Promise<string>;
}

export interface OpcionesCargaPaquete {
  agenteId: string;
  /** Versión que el entorno espera; si el manifiesto trae otra, se aborta. */
  versionEsperada: string;
  tamano: number;
  solapamiento: number;
}

export interface ResumenPaquete {
  fragmentos: number;
  /** Registros rechazados por el validador más archivos descartados. */
  rechazados: number;
  version: string;
}

/** Colección donde vive lo no validado del paquete; distinta de la base. */
export function coleccionPaquete(coleccionBase: string): string {
  return `${coleccionBase}--paquete`;
}

const CAMPOS_DE_CONTROL = ['habilitado_produccion', 'validacion', 'version_paquete'] as const;

function sinControl(registro: RegistroPlano): RegistroPlano {
  const copia: RegistroPlano = { ...registro };
  for (const c of CAMPOS_DE_CONTROL) delete copia[c];
  return copia;
}

function aRegistros(raiz: unknown): unknown[] | null {
  if (Array.isArray(raiz)) return raiz;
  if (typeof raiz !== 'object' || raiz === null) return null;
  const interno = (raiz as Record<string, unknown>)['registros'];
  return Array.isArray(interno) ? interno : [raiz];
}

export async function cargarPaqueteKuaa(
  lector: LectorPaquete,
  perfil: PerfilValidacion,
  indice: IndiceConocimiento,
  coleccion: string,
  opciones: OpcionesCargaPaquete,
  bitacora?: Bitacora,
): Promise<ResumenPaquete> {
  const manifiesto = esquemaManifiestoPaquete.parse(await lector.leerManifiesto());
  if (manifiesto.version !== opciones.versionEsperada) throw new Error('la versión del manifiesto no es la esperada');
  const version = manifiesto.version;
  const destino = coleccionPaquete(coleccion);
  const fragmentos: Fragmento[] = [];

  let rechazados = 0;
  for (const archivo of manifiesto.archivos) {
    const esJson = archivo.ruta.endsWith('.json');
    const esMd = archivo.ruta.endsWith('.md');
    if (!esJson && !esMd) {
      rechazados += 1;
      continue;
    }
    const base = archivo.ruta.replace(/\.(json|md)$/, '');
    const texto = await lector.leer(archivo.ruta);
    let registros: unknown[] | null;
    if (esMd) {
      registros = [{ id: base, texto: quitarComentariosHtml(texto), habilitado_produccion: false, validacion: 'no_validado', version_paquete: version }];
    } else {
      try {
        registros = aRegistros(JSON.parse(texto) as unknown);
      } catch {
        registros = null;
      }
    }
    if (registros === null) {
      rechazados += 1;
      continue;
    }

    const separacion = separarRegistrosHabilitados(registros, perfil);
    rechazados += separacion.rechazados.length;
    const todos = separacion.perfil === 'pruebas' ? separacion.aceptados : separacion.habilitados.map((registro) => ({ estado: 'habilitado' as const, registro }));
    // Del paquete solo entra lo `no_validado` y de la versión del manifiesto: un `habilitado` o una versión
    // ajena es un defecto de origen y se cuenta como rechazo.
    const aceptados = todos.filter((a): a is RegistroNoValidado => a.estado === 'no_validado' && a.version_paquete === version);
    rechazados += todos.length - aceptados.length;
    aceptados.forEach((a, i) => {
      const cuerpo = typeof a.registro['texto'] === 'string' && esMd ? a.registro['texto'] : JSON.stringify(sinControl(a.registro));
      const partes = trocear({ fuenteId: `${base}#${i}`, titulo: base, version, coleccion: destino, texto: cuerpo }, { tamano: opciones.tamano, solapamiento: opciones.solapamiento });
      for (const f of partes) fragmentos.push({ ...f, validacion: 'no_validado', versionPaquete: a.version_paquete });
    });
  }

  const fragmentosTotal = fragmentos.length;
  // Segunda barrera: bajo `produccion` jamás se indexa un fragmento marcado.
  if (perfil === 'produccion' && fragmentos.some((f) => f.validacion !== undefined || f.versionPaquete !== undefined)) {
    throw new Error('un fragmento no validado llegó al perfil produccion; carga abortada');
  }
  if (fragmentos.length > 0) await indice.indexar(fragmentos);

  bitacora?.registrar({
    tipo: 'corpus_indexado',
    agenteId: opciones.agenteId,
    perfilId: null,
    conversacionHash: '-',
    canal: '-',
    detalle: `paquete=${version} perfil=${perfil} coleccion=${destino} fragmentos=${fragmentosTotal} rechazados=${rechazados}`,
  });
  return { fragmentos: fragmentosTotal, rechazados, version };
}


/**
 * Carga el paquete VALIDADO (perfil `produccion`) en `<coleccion>--paquete`, sin marcas. Lanza si el manifiesto es
 * inválido o de otra versión, o si no queda ningún fragmento. La bitácora lleva solo conteos y la versión.
 */
export async function cargarPaqueteValidado(
  lector: LectorPaquete,
  indice: IndiceConocimiento,
  coleccion: string,
  opciones: OpcionesCargaPaquete,
  bitacora?: Bitacora,
): Promise<ResumenPaquete> {
  const manifiesto = esquemaManifiestoPaquete.parse(await lector.leerManifiesto());
  if (manifiesto.version !== opciones.versionEsperada) throw new Error('la versión del manifiesto no es la esperada');
  const version = manifiesto.version;
  const destino = coleccionPaquete(coleccion);
  const fragmentos: Fragmento[] = [];

  let rechazados = 0;
  for (const archivo of manifiesto.archivos) {
    // Solo `.json`: un documento de texto no trae la bandera de habilitación. Aborta, no se omite.
    if (!archivo.ruta.endsWith('.json')) throw new Error(`paquete validado: archivo no admitido (${archivo.ruta})`);
    const base = archivo.ruta.replace(/\.json$/, '');
    const texto = await lector.leer(archivo.ruta);
    let registros: unknown[] | null;
    try {
      registros = aRegistros(JSON.parse(texto) as unknown);
    } catch {
      registros = null;
    }
    if (registros === null) throw new Error(`paquete validado: JSON ilegible (${archivo.ruta})`);
    const separacion = separarRegistrosHabilitados(registros, 'produccion');
    rechazados += separacion.rechazados.length;
    // Defecto de origen: sin `version_paquete` o de otra versión, o con `validacion`, no entra.
    const aceptados = separacion.habilitados.filter((r) => r['version_paquete'] === version && r['validacion'] === undefined);
    rechazados += separacion.habilitados.length - aceptados.length;
    aceptados.forEach((r, i) => {
      const partes = trocear({ fuenteId: `${base}#${i}`, titulo: base, version, coleccion: destino, texto: JSON.stringify(sinControl(r)) }, { tamano: opciones.tamano, solapamiento: opciones.solapamiento });
      for (const f of partes) fragmentos.push({ ...f });
    });
  }

  // Segunda barrera: jamás se indexa un fragmento con marcas.
  if (fragmentos.some((f) => f.validacion !== undefined || f.versionPaquete !== undefined)) {
    throw new Error('un fragmento marcado llegó al paquete validado; carga abortada');
  }
  if (fragmentos.length === 0) throw new Error('paquete validado vacío');
  await indice.indexar(fragmentos);

  bitacora?.registrar({
    tipo: 'corpus_indexado',
    agenteId: opciones.agenteId,
    perfilId: null,
    conversacionHash: '-',
    canal: '-',
    detalle: `paquete_validado=${version} coleccion=${destino} fragmentos=${fragmentos.length} rechazados=${rechazados}`,
  });
  return { fragmentos: fragmentos.length, rechazados, version };
}
