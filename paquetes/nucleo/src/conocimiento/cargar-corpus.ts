/**
 * CARGA DEL CORPUS DE UN AGENTE
 *
 * Recorre las fuentes declaradas en la configuración (base y perfiles), lee los
 * archivos desde un `LectorArchivos` (abstracción para no depender del disco en
 * pruebas ni atar el servicio a un sistema de archivos) y los indexa por
 * colección.
 *
 * REGLA: solo se indexan fuentes con `visibilidad: "publico"`. Una fuente
 * `interno` puede figurar en la configuración (para que el panel la liste y para
 * documentar por qué existe), pero **el índice la rechaza**. Es la forma de que
 * «no brindar información confidencial» no dependa de que alguien se acuerde.
 *
 * La colección de un perfil es `<agenteId>--<perfilId>` salvo que el perfil fije
 * `conocimiento.coleccion`. Dos perfiles no comparten fragmentos por accidente.
 */
import type { ConfiguracionAgente, Fuente } from '../configuracion/esquema.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import type { IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import type { Bitacora } from '../puertos/bitacora.js';
import { trocear } from './trocear.js';

export interface LectorArchivos {
  leer(rutaRelativa: string): Promise<string>;
}

export function coleccionDe(config: ConfiguracionAgente, perfilId: string | null): string {
  const efectiva = resolverConfiguracion(config, perfilId);
  if (efectiva.conocimiento.coleccion) return efectiva.conocimiento.coleccion;
  return perfilId ? `${config.id}--${perfilId.toLowerCase()}` : config.id;
}

export interface ResumenCarga {
  colecciones: Record<string, { fuentes: number; fragmentos: number; omitidasInternas: number }>;
}

async function cargarFuentes(
  fuentes: Fuente[],
  coleccion: string,
  tamano: number,
  solapamiento: number,
  lector: LectorArchivos,
  indice: IndiceConocimiento,
): Promise<{ fuentes: number; fragmentos: number; omitidasInternas: number }> {
  let total = 0;
  let omitidas = 0;
  let cargadas = 0;
  for (const f of fuentes) {
    if (f.visibilidad !== 'publico') {
      omitidas++;
      continue;
    }
    const texto = await lector.leer(f.ruta);
    const fragmentos = trocear({ fuenteId: f.id, titulo: f.titulo, version: f.version, coleccion, texto }, { tamano, solapamiento });
    await indice.indexar(fragmentos);
    total += fragmentos.length;
    cargadas++;
  }
  return { fuentes: cargadas, fragmentos: total, omitidasInternas: omitidas };
}

export async function cargarCorpus(config: ConfiguracionAgente, lector: LectorArchivos, indice: IndiceConocimiento, bitacora?: Bitacora): Promise<ResumenCarga> {
  const resumen: ResumenCarga = { colecciones: {} };
  const ids: Array<string | null> = [null, ...Object.keys(config.perfiles)];
  for (const perfilId of ids) {
    const efectiva = resolverConfiguracion(config, perfilId);
    if (efectiva.conocimiento.modo !== 'rag') continue;
    const coleccion = coleccionDe(config, perfilId);
    await indice.vaciar(coleccion);
    // Un perfil que no redefine `fuentes` hereda las de la base (la fusión reemplaza arreglos,
    // así que si las redefine, son solo las suyas).
    const r = await cargarFuentes(efectiva.conocimiento.fuentes, coleccion, efectiva.conocimiento.tamanoFragmento, efectiva.conocimiento.solapamiento, lector, indice);
    resumen.colecciones[coleccion] = r;
    bitacora?.registrar({
      tipo: 'corpus_indexado',
      agenteId: config.id,
      perfilId,
      conversacionHash: '-',
      canal: '-',
      detalle: `coleccion=${coleccion} fuentes=${r.fuentes} fragmentos=${r.fragmentos} internas_omitidas=${r.omitidasInternas}`,
    });
  }
  return resumen;
}
