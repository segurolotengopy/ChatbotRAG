/**
 * CARGA DEL PAQUETE DE CONOCIMIENTO DE KUAA (perfil `pruebas`)
 *
 * Porqué: el paquete de conocimiento de Kuaa todavía no lo revisó nadie. Para probarlo en staging se
 * carga marcado `no_validado` y con su versión, y se vuelve visible en cada respuesta que lo usa. Esta
 * función es pura respecto de la nube: recibe un `LectorPaquete` (el adaptador de GCS vive en
 * `paquetes/conocimiento-gcs`), así que el núcleo no importa ningún SDK.
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
 * Qué NO garantiza: la veracidad ni la titularidad del contenido; ni la integridad de los archivos (la
 * verifica el lector, con el SHA-256 del manifiesto).
 */
import { z } from 'zod';
import type { Bitacora } from '../puertos/bitacora.js';
import type { Fragmento, IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import { quitarComentariosHtml } from './cargar-corpus.js';
import { separarRegistrosHabilitados, type PerfilValidacion, type RegistroPlano } from './registros-habilitados.js';
import { trocear } from './trocear.js';

export const esquemaManifiestoPaquete = z.object({
  version: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/),
  archivos: z
    .array(
      z.object({
        ruta: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*(\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/).max(200),
        titular: z.enum(['interseguros', 'alianza']),
        sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
        bytes: z.number().int().min(0).optional(),
      }),
    )
    .max(200),
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

  let fragmentosTotal = 0;
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
    const aceptados = separacion.perfil === 'pruebas' ? separacion.aceptados : separacion.habilitados.map((registro) => ({ estado: 'habilitado' as const, registro }));
    const fragmentos: Fragmento[] = [];
    aceptados.forEach((a, i) => {
      const cuerpo = typeof a.registro['texto'] === 'string' && esMd ? a.registro['texto'] : JSON.stringify(sinControl(a.registro));
      const partes = trocear({ fuenteId: `${base}#${i}`, titulo: base, version, coleccion, texto: cuerpo }, { tamano: opciones.tamano, solapamiento: opciones.solapamiento });
      for (const f of partes) fragmentos.push(a.estado === 'no_validado' ? { ...f, validacion: 'no_validado', versionPaquete: a.version_paquete } : f);
    });

    // Segunda barrera: bajo `produccion` jamás se indexa un fragmento marcado.
    if (perfil === 'produccion' && fragmentos.some((f) => f.validacion !== undefined || f.versionPaquete !== undefined)) {
      throw new Error('un fragmento no validado llegó al perfil produccion; carga abortada');
    }
    if (fragmentos.length > 0) await indice.indexar(fragmentos);
    fragmentosTotal += fragmentos.length;
  }

  bitacora?.registrar({
    tipo: 'corpus_indexado',
    agenteId: opciones.agenteId,
    perfilId: null,
    conversacionHash: '-',
    canal: '-',
    detalle: `paquete=${version} perfil=${perfil} coleccion=${coleccion} fragmentos=${fragmentosTotal} rechazados=${rechazados}`,
  });
  return { fragmentos: fragmentosTotal, rechazados, version };
}
