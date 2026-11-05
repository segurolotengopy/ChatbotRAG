/**
 * MEDICIÓN Y ELECCIÓN DE UMBRALES (modelo híbrido, H3)
 *
 * Por qué existe: el umbral de similitud no se adivina ni se copia de otro proyecto: se mide con casos cuya
 * respuesta correcta se conoce. `medir` cuenta qué habría hecho el emparejamiento semántico con cada caso;
 * `barrerUmbrales` repite la cuenta de 0,50 a 0,99 en pasos de 0,01 con los vectores YA calculados (no hace
 * llamadas nuevas al embebedor); `elegirUmbral` toma el MENOR umbral que no produce ninguna confusión ni ningún
 * falso positivo sobre los casos «ninguna» de la calibración, y reporta cómo le va en el control.
 *
 * Defecto que motiva el control: elegir el umbral por «el que da más aciertos» acepta confusiones (una entrada
 * tomada por otra), que es el error caro: sale un texto aprobado equivocado, sin revisión. D4 exige confusión
 * cero. Por eso el criterio es de seguridad y no de cobertura, y si ningún umbral lo cumple el resultado es
 * `null`: nunca hay un valor por defecto, tampoco el piso del barrido. D8, POR PARTICIÓN: cada partición necesita
 * al menos 5 casos por entrada del índice y al menos 30 casos «ninguna». Sin ellos en la calibración no se elige
 * nada (`null`: una calibración vacía o sin «ninguna» daría 0,50 «sin errores» por ausencia de datos); sin ellos
 * en el control, o con una confusión o un falso positivo «ninguna» en el control, la calibración es inválida.
 *
 * Definiciones: acierto = la propuesta coincide con lo esperado (entrada exacta, o ninguna propuesta si se
 * esperaba «ninguna»); confusión = se esperaba la entrada X y se propuso otra Y; falso positivo = se esperaba
 * «ninguna» y se propuso una entrada; falso negativo = se esperaba una entrada y no se propuso ninguna (va a la
 * IA: es seguro, pero cuesta cobertura); cobertura = aciertos con entrada sobre casos con entrada esperada.
 *
 * Qué NO garantiza: que el umbral generalice al tráfico real (un conjunto chico o poco variado lo sobreestima),
 * que el control sea independiente de la calibración (lo decide quien arma el conjunto), ni que sirva con otro
 * modelo, otra dimensión u otro banco: el resultado se liga a esos tres y debe repetirse si cambia alguno. No
 * conecta nada al agente (H4) ni enciende `carrilFijo`. El paso de 0,01 es una rejilla, no una garantía de
 * óptimo. No hace red, no lee el entorno ni lleva texto de los casos: solo ids y conteos.
 */
import type { Esperado } from './evaluacion.js';
import { ErrorSimilitud } from './similitud.js';
import type { CoincidenciaSemantica, IndiceSemantico, PuntajeEntrada, UmbralesSemanticos } from './similitud.js';
import { decidirEmparejamiento, puntuarEntradas } from './similitud.js';

export const MINIMO_POR_ENTRADA = 5;
export const MINIMO_NINGUNA = 30;
export const UMBRAL_MINIMO_BARRIDO = 0.5;
export const UMBRAL_MAXIMO_BARRIDO = 0.99;

export interface CasoMedible {
  id: string;
  vector: readonly number[];
  esperado: Esperado;
  particion: 'calibracion' | 'control';
}

export interface Conteos {
  total: number;
  aciertos: number;
  confusiones: number;
  falsosPositivos: number;
  falsosNegativos: number;
  casosConEntrada: number;
  casosNinguna: number;
  /** Aciertos con entrada sobre casos con entrada esperada (0 si no hay ninguno). */
  cobertura: number;
}

function clasificar(esperado: Esperado, propuesta: CoincidenciaSemantica | null): 'acierto' | 'confusion' | 'falsoPositivo' | 'falsoNegativo' {
  if (esperado.tipo === 'ninguna') return propuesta === null ? 'acierto' : 'falsoPositivo';
  if (propuesta === null) return 'falsoNegativo';
  return propuesta.tipo === esperado.tipo && propuesta.entradaId === esperado.entradaId ? 'acierto' : 'confusion';
}

function contar(items: ReadonlyArray<{ esperado: Esperado; propuesta: CoincidenciaSemantica | null }>): Conteos {
  const c: Conteos = { total: items.length, aciertos: 0, confusiones: 0, falsosPositivos: 0, falsosNegativos: 0, casosConEntrada: 0, casosNinguna: 0, cobertura: 0 };
  let aciertosConEntrada = 0;
  for (const { esperado, propuesta } of items) {
    if (esperado.tipo === 'ninguna') c.casosNinguna++;
    else c.casosConEntrada++;
    const r = clasificar(esperado, propuesta);
    if (r === 'acierto') {
      c.aciertos++;
      if (esperado.tipo !== 'ninguna') aciertosConEntrada++;
    } else if (r === 'confusion') c.confusiones++;
    else if (r === 'falsoPositivo') c.falsosPositivos++;
    else c.falsosNegativos++;
  }
  c.cobertura = c.casosConEntrada === 0 ? 0 : aciertosConEntrada / c.casosConEntrada;
  return c;
}

/** Cuenta lo que habría pasado con cada caso para un par de umbrales. Quien llama filtra por partición. */
export function medir(casos: readonly CasoMedible[], indice: IndiceSemantico, umbrales: UmbralesSemanticos): Conteos {
  return contar(casos.map((c) => ({ esperado: c.esperado, propuesta: decidirEmparejamiento(puntuarEntradas(c.vector, indice), umbrales) })));
}

export interface FilaBarrido {
  umbralFijo: number;
  umbralDerivacion: number;
  margen: number;
  calibracion: Conteos;
  control: Conteos;
}

export interface OpcionesBarrido {
  margen: number;
  /** Cuánto menos exige la derivación que la respuesta fija (D7). Por defecto 0: mismo umbral. */
  diferenciaDerivacion?: number;
}

const centesimas = (n: number): number => Math.round(n * 100) / 100;

/** Umbrales de 0,50 a 0,99 en pasos de 0,01. Los cosenos se calculan una sola vez por caso. */
export function barrerUmbrales(casos: readonly CasoMedible[], indice: IndiceSemantico, opciones: OpcionesBarrido): FilaBarrido[] {
  const diferencia = opciones.diferenciaDerivacion ?? 0;
  if (!Number.isFinite(diferencia) || diferencia < 0) throw new ErrorSimilitud('diferenciaDerivacion debe ser finita y no negativa');
  if (!Number.isFinite(opciones.margen) || opciones.margen < 0 || opciones.margen > 1) throw new ErrorSimilitud('margen fuera de [0, 1]');
  const puntajes: Array<{ caso: CasoMedible; puntajes: PuntajeEntrada[] }> = casos.map((caso) => ({ caso, puntajes: puntuarEntradas(caso.vector, indice) }));
  const filas: FilaBarrido[] = [];
  for (let k = Math.round(UMBRAL_MINIMO_BARRIDO * 100); k <= Math.round(UMBRAL_MAXIMO_BARRIDO * 100); k++) {
    const umbralFijo = k / 100;
    const umbralDerivacion = Math.max(centesimas(umbralFijo - diferencia), 0.01);
    const umbrales = { umbralFijo, umbralDerivacion, margen: opciones.margen };
    const porParticion = (particion: CasoMedible['particion']) =>
      contar(puntajes.filter((p) => p.caso.particion === particion).map((p) => ({ esperado: p.caso.esperado, propuesta: decidirEmparejamiento(p.puntajes, umbrales) })));
    filas.push({ ...umbrales, calibracion: porParticion('calibracion'), control: porParticion('control') });
  }
  return filas;
}

export interface MinimosParticion {
  /** Menor cantidad de casos de la partición entre las entradas del índice. */
  minimoPorEntrada: number;
  casosNinguna: number;
  cumple: boolean;
}

export interface Minimos {
  calibracion: MinimosParticion;
  control: MinimosParticion;
  /** Ambas particiones cumplen. */
  cumple: boolean;
}

function minimosDe(casos: readonly Pick<CasoMedible, 'esperado' | 'particion'>[], indice: IndiceSemantico, particion: CasoMedible['particion']): MinimosParticion {
  const porEntrada = new Map<string, number>();
  for (const v of indice.vectores) porEntrada.set(v.entradaId, 0);
  let casosNinguna = 0;
  for (const c of casos) {
    if (c.particion !== particion) continue;
    if (c.esperado.tipo === 'ninguna') casosNinguna++;
    else if (c.esperado.entradaId !== undefined && porEntrada.has(c.esperado.entradaId)) {
      porEntrada.set(c.esperado.entradaId, (porEntrada.get(c.esperado.entradaId) ?? 0) + 1);
    }
  }
  const minimoPorEntrada = porEntrada.size === 0 ? 0 : Math.min(...porEntrada.values());
  return { minimoPorEntrada, casosNinguna, cumple: minimoPorEntrada >= MINIMO_POR_ENTRADA && casosNinguna >= MINIMO_NINGUNA };
}

/** Mínimos de D8 por partición: ≥5 casos por entrada del índice y ≥30 casos «ninguna» en CADA una. */
export function verificarMinimos(casos: readonly Pick<CasoMedible, 'esperado' | 'particion'>[], indice: IndiceSemantico): Minimos {
  const calibracion = minimosDe(casos, indice, 'calibracion');
  const control = minimosDe(casos, indice, 'control');
  return { calibracion, control, cumple: calibracion.cumple && control.cumple };
}

export const MOTIVOS_INVALIDEZ = ['confusion_en_control', 'falso_positivo_en_control', 'minimos_insuficientes'] as const;
export type MotivoInvalidez = (typeof MOTIVOS_INVALIDEZ)[number];

export interface UmbralElegido extends UmbralesSemanticos {
  calibracion: Conteos;
  control: Conteos;
  minimos: Minimos;
  valido: boolean;
  motivosInvalidez: MotivoInvalidez[];
}

/**
 * El MENOR umbral con cero confusiones y cero falsos positivos «ninguna» en calibración. `null` si no hay
 * ninguno o si la calibración no cumple los mínimos de D8: nunca se inventa un valor ni se usa el piso del
 * barrido. El control no cambia la elección: solo la valida o la invalida (confusión, falso positivo «ninguna»
 * o mínimos de control sin cumplir).
 */
export function elegirUmbral(filas: readonly FilaBarrido[], minimos: Minimos): UmbralElegido | null {
  if (!minimos.calibracion.cumple) return null;
  const factibles = filas.filter((f) => f.calibracion.confusiones === 0 && f.calibracion.falsosPositivos === 0);
  const elegida = factibles.reduce<FilaBarrido | null>((m, f) => (m === null || f.umbralFijo < m.umbralFijo ? f : m), null);
  if (elegida === null) return null;
  const motivosInvalidez: MotivoInvalidez[] = [];
  if (elegida.control.confusiones > 0) motivosInvalidez.push('confusion_en_control');
  if (elegida.control.falsosPositivos > 0) motivosInvalidez.push('falso_positivo_en_control');
  if (!minimos.control.cumple) motivosInvalidez.push('minimos_insuficientes');
  return {
    umbralFijo: elegida.umbralFijo,
    umbralDerivacion: elegida.umbralDerivacion,
    margen: elegida.margen,
    calibracion: elegida.calibracion,
    control: elegida.control,
    minimos,
    valido: motivosInvalidez.length === 0,
    motivosInvalidez,
  };
}
