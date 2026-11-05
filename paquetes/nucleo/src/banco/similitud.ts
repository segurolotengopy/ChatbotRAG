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
 * Regla B (confirmada en H4a): derivación casi empatada con la respuesta LÍDER. Una derivación que alcanza
 * `umbralDerivacion` y está a lo sumo a `margen` de la respuesta de mayor puntaje deriva, esté o no esa respuesta sobre
 * su umbral; ver `decidirEmparejamiento`.
 *
 * Reglas: «supera» significa puntaje mayor o igual que el umbral de SU tipo (el borde cuenta, con tolerancia `EPSILON`
 * de 1e-9 para el redondeo); el margen se mide
 * entre el mejor puntaje de la entrada elegida y el mejor puntaje de cualquier OTRA entrada (nunca contra otra
 * pregunta de la misma entrada), y se compara con un mínimo de cero si no hay otra entrada. Es determinista, no
 * muta el banco ni el índice, no hace red, no lee el entorno y no construye expresiones con datos.
 *
 * Qué NO garantiza: que el modelo de embeddings entienda bien el dominio, que un umbral sea el correcto (lo fija
 * la medición de `medir.ts`, ligada a modelo, dimensión y SHA-256 del banco; no vive en el código), ni que dos
 * entradas con el mismo sentido no se confundan. Tampoco decide el carril: devuelve una propuesta; el carril lo decide
 * `enrutador-semantico.ts` y la conexión al agente es de H4d. Un `coseno` con vectores de largo distinto o con valores no finitos lanza error; un vector
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

/**
 * Similitud coseno en [-1, 1]. Largo distinto, vacío o valores no finitos: error. Vector nulo (todo en cero): 0. Las
 * magnitudes extremas (enormes o diminutas) se manejan escalando cada vector por su mayor valor absoluto: ni se
 * desborda a NaN ni se confunde un vector diminuto con uno nulo.
 */
export function coseno(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new ErrorSimilitud('vectores de largo distinto');
  if (a.length === 0) throw new ErrorSimilitud('vectores vacíos');
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) throw new ErrorSimilitud('vector con valores no finitos');
  }
  const productos = (x: readonly number[], y: readonly number[], fx = 1, fy = 1) => {
    let punto = 0;
    let nx = 0;
    let ny = 0;
    for (let i = 0; i < x.length; i++) {
      const u = (x[i] as number) / fx;
      const v = (y[i] as number) / fy;
      punto += u * v;
      nx += u * u;
      ny += v * v;
    }
    return { punto, nx, ny };
  };
  const RANGO_BAJO = 1e-280;
  const RANGO_ALTO = 1e280;
  const enRango = (n: number): boolean => Number.isFinite(n) && n > RANGO_BAJO && n < RANGO_ALTO;
  let { punto, nx: na, ny: nb } = productos(a, b);
  if (!(enRango(na) && enRango(nb) && Number.isFinite(punto))) {
    // Componentes enormes (> 1e140: los cuadrados desbordan) o diminutos (< 1e-140: los cuadrados se pierden o son
    // subnormales) no se pueden elevar al cuadrado tal cual. El coseno no depende de la escala de cada vector, así que se
    // divide cada uno por su mayor valor absoluto. Un vector con todo en cero es nulo y vale 0.
    const ma = a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    const mb = b.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    if (ma === 0 || mb === 0) return 0;
    ({ punto, nx: na, ny: nb } = productos(a, b, ma, mb));
  }
  if (na === 0 || nb === 0) return 0;
  // El recorte absorbe el error de redondeo (1.0000000000000002).
  const c = Math.max(-1, Math.min(1, punto / (Math.sqrt(na) * Math.sqrt(nb))));
  // Defensa final: un puntaje no finito (`Math.min/max` propagan NaN) no se acepta jamás.
  if (!Number.isFinite(c)) throw new ErrorSimilitud('similitud no finita');
  return c;
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

/**
 * Versión de la regla de decisión de `decidirEmparejamiento`. Una calibración se mide con una regla concreta y solo
 * sirve con esa: `calibracion.json` lleva el campo `regla` y `verificarCalibracion` exige que sea igual a esta
 * constante. Súbala cada vez que cambie cómo se deciden umbrales, margen o empates (1 = regla B monótona de H4a; la
 * de H3 no tenía versión y sus calibraciones, sin el campo, se rechazan).
 */
export const VERSION_REGLA_DECISION = 1;

/** Tolerancia fija para las comparaciones de umbral y margen: absorbe el redondeo de la coma flotante en el borde. */
export const EPSILON = 1e-9;

/**
 * Aplica la regla de umbral, margen y empate a puntajes ya calculados. No muta `entradas`. Todas las comparaciones
 * de umbral y de margen toleran `EPSILON` (1e-9), de modo que una diferencia exactamente igual al margen, o un
 * puntaje exactamente en el umbral, cuentan aunque el redondeo los deje una millonésima de millonésima por debajo.
 *
 * Regla B (confirmada por Andres): derivación casi empatada con la respuesta LÍDER. Sea «candidata» la mejor
 * derivación y «líder» la respuesta de mayor puntaje. Si la candidata alcanza `umbralDerivacion` y está casi empatada
 * con la respuesta líder (a lo sumo `margen` de distancia, en cualquiera de los dos sentidos), DERIVA, esté o no la
 * líder sobre `umbralFijo` (derivar de más es la dirección segura). Debe además distanciarse al menos `margen` de la
 * mejor de las demás entradas (excluidas la candidata y las respuestas casi empatadas con ella; otra derivación
 * cercana da nulo: hay duda). Si la respuesta líder está claramente por encima de la candidata (más allá del
 * margen), la candidata no está empatada con la líder y se aplica la regla común: esa respuesta se propone si cumple
 * su umbral y su margen, y si no, el resultado es nulo. Así no hay franja donde una derivación más parecida iba a la
 * IA (la no-monotonía de H3). Ejemplos fijados en las pruebas (umbralFijo 0,80, umbralDerivacion 0,70, margen 0,05):
 * r0 0,70, r1 0,80, d 0,70 → respuesta r1; r0 0,70, r1 0,76, d 0,70 → nulo; d 0,79, r0 0,80, r1 0,845 → nulo.
 *
 * Fuera de esa zona de empate: una respuesta es «bajo umbral» si no alcanza `umbralFijo`; no puede proponerse y no
 * compite por el margen de una derivación líder. Si la mejor entrada es una respuesta bajo umbral, o una derivación
 * bajo `umbralDerivacion`, el resultado es nulo.
 *
 * Margen devuelto: distancia real a la siguiente mejor entrada que compite; si la única otra es una respuesta
 * excluida (o casi empatada), la distancia a ella; si no hay otra, el puntaje (distancia a cero). Cuando la única
 * otra es una respuesta excluida o casi empatada puede ser MENOR que `umbrales.margen`: quien consuma el resultado
 * no debe suponer ese invariante.
 */
export function decidirEmparejamiento(entradas: readonly PuntajeEntrada[], umbrales: UmbralesSemanticos): CoincidenciaSemantica | null {
  validarUmbrales(umbrales);
  if (entradas.length === 0) return null;
  // Defensa en profundidad: con un puntaje no finito (NaN, Infinity) no se propone nada.
  if (entradas.some((e) => !Number.isFinite(e.puntaje))) return null;
  // Puntaje descendente; ante empate, la derivación primero; ante empate total, el orden del índice (sort estable).
  const orden = [...entradas].sort((x, y) => y.puntaje - x.puntaje || (x.tipo === y.tipo ? 0 : x.tipo === 'derivacion' ? -1 : 1));
  const mejor = orden[0] as PuntajeEntrada;

  const candidata = orden.find((e) => e.tipo === 'derivacion');
  if (candidata !== undefined && candidata.puntaje >= umbrales.umbralDerivacion - EPSILON) {
    const empatadas = orden.filter((e) => e.tipo === 'respuesta' && Math.abs(e.puntaje - candidata.puntaje) <= umbrales.margen + EPSILON);
    if (empatadas.length > 0) {
      const otra = orden.find((e) => e !== candidata && !empatadas.includes(e));
      // Una respuesta claramente por encima de la candidata (más allá del margen) no es una duda: la candidata no
      // lidera y decide la regla común de abajo (esa respuesta se propone si cumple su umbral y su margen).
      const encima = otra !== undefined && otra.tipo === 'respuesta' && otra.puntaje > candidata.puntaje;
      if (!encima) {
        if (candidata.puntaje - Math.max(otra?.puntaje ?? 0, 0) < umbrales.margen - EPSILON) return null;
        const referencia = otra !== undefined ? candidata.puntaje - otra.puntaje : Math.min(...empatadas.map((e) => Math.abs(candidata.puntaje - e.puntaje)));
        return { tipo: 'derivacion', entradaId: candidata.entradaId, puntaje: candidata.puntaje, margen: referencia };
      }
    }
  }

  const bajoUmbralFijo = (e: PuntajeEntrada | undefined): boolean => e?.tipo === 'respuesta' && e.puntaje < umbrales.umbralFijo - EPSILON;
  if (bajoUmbralFijo(mejor)) return null;
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
