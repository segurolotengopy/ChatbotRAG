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

const ABRE_COMENTARIO = '<!--';
const CIERRES_COMENTARIO = ['-->', '--!>'] as const;

/**
 * Busca el próximo cierre de comentario sin repetir trabajo: guarda, por cada tipo de cierre,
 * la última posición hallada y solo vuelve a buscar cuando ya quedó atrás. Sin esto, cada
 * comentario recorrería de nuevo todo el texto buscando un cierre que quizá no existe (tiempo
 * cuadrático con muchos comentarios y ningún `--!>`).
 */
function crearBuscadorDeCierre(texto: string): (desde: number) => { posicion: number; largo: number } | null {
  const siguiente: number[] = CIERRES_COMENTARIO.map(() => -2); // -2: sin buscar, -1: no hay más
  return (desde) => {
    let mejor: { posicion: number; largo: number } | null = null;
    CIERRES_COMENTARIO.forEach((cierre, i) => {
      if (siguiente[i] === -1) return;
      if (siguiente[i]! < desde) siguiente[i] = texto.indexOf(cierre, desde);
      const posicion = siguiente[i]!;
      if (posicion !== -1 && (mejor === null || posicion < mejor.posicion)) mejor = { posicion, largo: cierre.length };
    });
    return mejor;
  };
}

/**
 * Quita los comentarios HTML repitiendo la pasada hasta que el texto no cambie: una sola
 * pasada deja pasar `<!<!-- x -->-- texto -->` (al quitar el interior se forma otro comentario).
 * Se recorre con `indexOf`, sin expresiones regulares: un `<!--[\s\S]*?-->` tarda un tiempo
 * polinómico con muchos `<!--` sin cerrar (alerta `js/polynomial-redos` de CodeQL), y una
 * regexp solo con `-->` ignora el cierre `--!>` que el HTML también acepta (`js/bad-tag-filter`).
 * NO garantiza limpiar un `<!--` sin cerrar: queda en el texto, y por eso `validar-config`
 * rechaza las fuentes de página donde sobre `<!--`, `-->` o `--!>`.
 */
export function quitarComentariosHtml(texto: string): string {
  let actual = texto;
  for (;;) {
    let salida = '';
    let desde = 0;
    const buscarCierre = crearBuscadorDeCierre(actual);
    for (;;) {
      const abre = actual.indexOf(ABRE_COMENTARIO, desde);
      if (abre === -1) break;
      const cierre = buscarCierre(abre + ABRE_COMENTARIO.length);
      if (cierre === null) break;
      salida += actual.slice(desde, abre);
      desde = cierre.posicion + cierre.largo;
    }
    salida += actual.slice(desde);
    if (salida === actual) return actual;
    actual = salida;
  }
}

/** Indica si queda alguna marca de comentario HTML suelta (apertura o cualquiera de los cierres). */
export function quedaMarcaDeComentario(texto: string): boolean {
  return texto.includes(ABRE_COMENTARIO) || CIERRES_COMENTARIO.some((c) => texto.includes(c));
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
    // Los comentarios HTML (`<!-- id | … -->`) son metadatos del autor del manual, no contenido:
    // no se indexan ni llegan al prompt. Los documentos sin comentarios quedan idénticos.
    const texto = quitarComentariosHtml(await lector.leer(f.ruta));
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
