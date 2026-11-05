/**
 * EMPAREJAMIENTO SEMÁNTICO DEL BANCO (modelo híbrido, H3)
 *
 * Por qué existe: la coincidencia exacta de H2 deja sin atender preguntas que significan lo mismo con otras
 * palabras. Este módulo SUMA una segunda vía a la exacta (la exacta sigue yendo primero; `enrutar()` no cambia):
 * compara el vector de la pregunta con los vectores de las preguntas del banco y propone una entrada solo si
 * supera un umbral y se distancia lo suficiente de cualquier otra entrada.
 *
 * Defecto que motiva el control: la similitud siempre devuelve «el más parecido», aunque nada se parezca. Una
 * respuesta fija elegida así sale con la autoridad de «texto aprobado» sin serlo. Por eso hay dos umbrales
 * asimétricos (la derivación puede exigir menos que la respuesta fija: derivar de más es la dirección segura),
 * un margen contra la mejor OTRA entrada y un resultado nulo ante la duda. Si una derivación y una respuesta
 * empatan en puntaje, el orden pone primero a la derivación (con margen mayor que cero el empate igual da nulo,
 * porque la distancia entre ambas es cero).
 *
 * Regla B: si la mejor entrada es una respuesta que no alcanza `umbralFijo` y una derivación casi empatada con ella
 * (a lo sumo `margen` de distancia) alcanza `umbralDerivacion`, gana la derivación en vez de dar nulo.
 *
 * Reglas: «supera» significa puntaje mayor o igual que el umbral de SU tipo (el borde cuenta, con tolerancia `EPSILON`
 * de 1e-9 para el redondeo); el margen se mide
 * entre el mejor puntaje de la entrada elegida y el mejor puntaje de cualquier OTRA entrada (nunca contra otra
 * pregunta de la misma entrada), y se compara con un mínimo de cero si no hay otra entrada. Es determinista, no
 * muta el banco ni el índice, no hace red, no lee el entorno y no construye expresiones con datos.
 *
 * Qué NO garantiza: que el modelo de embeddings entienda bien el dominio, que un umbral sea el correcto (lo fija
 * la medición de `medir.ts`, ligada a modelo, dimensión y SHA-256 del banco; no vive en el código), ni que dos
 * entradas con el mismo sentido no se confundan. Tampoco decide el carril: devuelve una propuesta, y la conexión
 * al agente es de H4. Un `coseno` con vectores de largo distinto o con valores no finitos lanza error; un vector
 * nulo (norma cero) vale 0, porque no apunta a ninguna parte.
 */
import type { Embebedor } from '../puertos/proveedor-llm.js';
import type { BancoRespuestas } from './esquema.js';

export type TipoEntrada = 'respuesta' | 'derivacion';

export class ErrorSimilitud extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorSimilitud';
  }
}

/** Similitud coseno en [-1, 1]. Largo distinto, vacío o valores no finitos: error. Vector nulo: 0. */
export function coseno(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new ErrorSimilitud('vectores de largo distinto');
  if (a.length === 0) throw new ErrorSimilitud('vectores vacíos');
  let punto = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new ErrorSimilitud('vector con valores no finitos');
    punto += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  // El recorte absorbe el error de redondeo (1.0000000000000002).
  return Math.max(-1, Math.min(1, punto / (Math.sqrt(na) * Math.sqrt(nb))));
}

export interface VectorEntrada {
  entradaId: string;
  tipo: TipoEntrada;
  vector: readonly number[];
}

export interface IndiceSemantico {
  /** Nombre y dimensión del embebedor con el que se construyó: la calibración queda ligada a ellos. */
  modelo: string;
  dimension: number;
  /** Un vector por pregunta del banco (una entrada con varias preguntas aparece varias veces). */
  vectores: ReadonlyArray<VectorEntrada>;
}

/** Embebe las preguntas de respuestas y derivaciones (derivaciones sin preguntas, solo con términos, no entran). */
export async function prepararIndiceSemantico(banco: BancoRespuestas, embebedor: Embebedor): Promise<IndiceSemantico> {
  const etiquetas: Array<{ entradaId: string; tipo: TipoEntrada }> = [];
  const textos: string[] = [];
  // Primero las derivaciones, como en el enrutador exacto.
  for (const e of banco.derivaciones) {
    for (const p of e.preguntas) {
      etiquetas.push({ entradaId: e.id, tipo: 'derivacion' });
      textos.push(p);
    }
  }
  for (const e of banco.respuestas) {
    for (const p of e.preguntas) {
      etiquetas.push({ entradaId: e.id, tipo: 'respuesta' });
      textos.push(p);
    }
  }
  const matriz = textos.length === 0 ? [] : await embebedor.embeber(textos);
  if (matriz.length !== textos.length) throw new ErrorSimilitud('el embebedor devolvió una cantidad distinta de vectores');
  const vectores = etiquetas.map((et, i) => {
    const vector = matriz[i] as number[];
    if (vector.length !== embebedor.dimension) throw new ErrorSimilitud('un vector no tiene la dimensión declarada');
    return { ...et, vector: [...vector] };
  });
  return { modelo: embebedor.nombre, dimension: embebedor.dimension, vectores };
}

export interface UmbralesSemanticos {
  umbralFijo: number;
  umbralDerivacion: number;
  margen: number;
}

/**
 * Propuesta del emparejamiento. `margen` es la distancia a la siguiente mejor entrada que compite; en la regla B (y
 * cuando la única otra entrada es una respuesta bajo umbral) puede ser MENOR que `umbrales.margen`: H4 no debe
 * suponer ese invariante.
 */
export interface CoincidenciaSemantica {
  tipo: TipoEntrada;
  entradaId: string;
  puntaje: number;
  margen: number;
}

function validarUmbrales(u: UmbralesSemanticos): void {
  for (const v of [u.umbralFijo, u.umbralDerivacion]) {
    if (!Number.isFinite(v) || v <= 0 || v > 1) throw new ErrorSimilitud('umbral fuera de (0, 1]');
  }
  if (!Number.isFinite(u.margen) || u.margen < 0 || u.margen > 1) throw new ErrorSimilitud('margen fuera de [0, 1]');
}

export interface PuntajeEntrada {
  entradaId: string;
  tipo: TipoEntrada;
  puntaje: number;
}

/**
 * Mejor puntaje por entrada. El orden de inserción sigue el del índice, así el resultado es determinista. Se
 * separa de la decisión para que el barrido de umbrales de `medir.ts` calcule los cosenos una sola vez.
 */
export function puntuarEntradas(vector: readonly number[], indice: IndiceSemantico): PuntajeEntrada[] {
  const mejores = new Map<string, PuntajeEntrada>();
  for (const v of indice.vectores) {
    const puntaje = coseno(vector, v.vector);
    const previo = mejores.get(v.entradaId);
    if (previo === undefined) mejores.set(v.entradaId, { entradaId: v.entradaId, tipo: v.tipo, puntaje });
    else if (puntaje > previo.puntaje) previo.puntaje = puntaje;
  }
  return [...mejores.values()];
}

/** Tolerancia fija para las comparaciones de umbral y margen: absorbe el redondeo de la coma flotante en el borde. */
export const EPSILON = 1e-9;

/**
 * Aplica la regla de umbral, margen y empate a puntajes ya calculados. No muta `entradas`. Todas las comparaciones
 * de umbral y de margen toleran `EPSILON` (1e-9), de modo que una diferencia exactamente igual al margen, o un
 * puntaje exactamente en el umbral, cuentan aunque el redondeo los deje una millonésima de millonésima por debajo.
 *
 * Una respuesta «bajo umbral» es una que no alcanza `umbralFijo`: no puede proponerse, así que no compite por el
 * margen de una derivación.
 *
 * Regla B (derivar de más es la dirección segura): la mejor entrada es una RESPUESTA (la «líder») bajo umbral.
 * Gana entonces la mejor derivación (la «candidata») solo si: (1) alcanza `umbralDerivacion`; (2) está casi
 * empatada con la líder: `líder - candidata <= margen` (una derivación lejos de la líder no es motivo para
 * derivar); y (3) se distancia al menos `margen` de la mejor de las DEMÁS entradas, excluyendo solo a la líder.
 * Si la mejor entrada es una derivación bajo su umbral, el resultado es nulo.
 *
 * Simétrico a la regla B: si la mejor entrada es una derivación y la segunda es una respuesta bajo umbral, el
 * margen de la derivación se mide contra la mejor entrada excluyendo esa respuesta.
 *
 * Margen devuelto: distancia real a la siguiente mejor entrada que compite; si la única otra es la respuesta
 * excluida (o la líder, en la regla B), la distancia a ella; si no hay otra, el puntaje (distancia a cero). En esos
 * casos puede ser MENOR que `umbrales.margen`: quien consuma el resultado no debe suponer ese invariante.
 *
 * Única no-monotonía que queda: si una derivación está a menos de `margen` de una respuesta, la respuesta bajo
 * `umbralFijo` cede ante la derivación (deriva), pero en cuanto la respuesta alcanza `umbralFijo` ambas son
 * propuestas casi empatadas y el resultado pasa a ser nulo (va a la IA), por falta de margen.
 */
export function decidirEmparejamiento(entradas: readonly PuntajeEntrada[], umbrales: UmbralesSemanticos): CoincidenciaSemantica | null {
  validarUmbrales(umbrales);
  if (entradas.length === 0) return null;
  // Puntaje descendente; ante empate, la derivación primero; ante empate total, el orden del índice (sort estable).
  const orden = [...entradas].sort((x, y) => y.puntaje - x.puntaje || (x.tipo === y.tipo ? 0 : x.tipo === 'derivacion' ? -1 : 1));
  const mejor = orden[0] as PuntajeEntrada;
  const bajoUmbralFijo = (e: PuntajeEntrada | undefined): boolean => e?.tipo === 'respuesta' && e.puntaje < umbrales.umbralFijo - EPSILON;
  if (bajoUmbralFijo(mejor)) {
    const candidata = orden.find((e) => e.tipo === 'derivacion');
    if (candidata === undefined || candidata.puntaje < umbrales.umbralDerivacion - EPSILON) return null;
    if (mejor.puntaje - candidata.puntaje > umbrales.margen + EPSILON) return null;
    const otra = orden.find((e) => e !== mejor && e !== candidata);
    if (candidata.puntaje - Math.max(otra?.puntaje ?? 0, 0) < umbrales.margen - EPSILON) return null;
    const margen = otra === undefined ? mejor.puntaje - candidata.puntaje : candidata.puntaje - otra.puntaje;
    return { tipo: 'derivacion', entradaId: candidata.entradaId, puntaje: candidata.puntaje, margen };
  }
  const umbral = mejor.tipo === 'derivacion' ? umbrales.umbralDerivacion : umbrales.umbralFijo;
  if (mejor.puntaje < umbral - EPSILON) return null;
  const excluida = mejor.tipo === 'derivacion' && bajoUmbralFijo(orden[1]) ? orden[1] : undefined;
  const otro = orden.find((e) => e !== mejor && e !== excluida);
  if (mejor.puntaje - Math.max(otro?.puntaje ?? 0, 0) < umbrales.margen - EPSILON) return null;
  const referencia = (otro ?? excluida)?.puntaje ?? 0;
  return { tipo: mejor.tipo, entradaId: mejor.entradaId, puntaje: mejor.puntaje, margen: mejor.puntaje - referencia };
}

export function emparejarSemantico(vector: readonly number[], indice: IndiceSemantico, umbrales: UmbralesSemanticos): CoincidenciaSemantica | null {
  return decidirEmparejamiento(puntuarEntradas(vector, indice), umbrales);
}
