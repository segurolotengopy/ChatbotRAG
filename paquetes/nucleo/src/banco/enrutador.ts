/**
 * ENRUTADOR DETERMINISTA DE TRES CARRILES (modelo híbrido, H2)
 *
 * Por qué existe: en el modelo híbrido cada mensaje sigue uno de tres carriles: `fijo` (respuesta aprobada del
 * banco), `derivacion` (texto aprobado que pasa la conversación a una persona) o `ia` (el agente de siempre, con
 * RAG). Este módulo solo DECIDE el carril; no arma textos (eso es `texto-fijo.ts`) ni se conecta al agente (H4).
 *
 * Defecto que motiva el control: una respuesta fija equivocada es peor que la del modelo, porque sale sin
 * revisión y con la autoridad de «texto aprobado». Por eso la coincidencia es EXACTA (nada de parciales ni de
 * similitud) y ante la duda gana la derivación o la IA. Además, el texto de la persona nunca llega a la decisión
 * ni a los avisos de la bitácora: eso rompería la confidencialidad. Una decisión lleva solo ids y enumerados.
 *
 * Orden fijo: (a) enrutador apagado, (b) sin contenido, (c) término de emergencia, (d) pregunta conocida,
 * (e) sin coincidencia. La derivación va primero: un término de emergencia gana sobre cualquier respuesta fija.
 * No se construye ninguna expresión regular con datos del banco: los términos se buscan como palabras completas
 * comparando grupos de palabras consecutivas del texto normalizado contra un mapa de términos, de modo que no hay
 * ReDoS posible y el costo no crece con la cantidad de términos. Se prueban dos variantes del mensaje (el
 * invisible dentro de una palabra o como separador).
 *
 * Qué NO garantiza: homóglifos de otros alfabetos (una «е» cirílica evita un término), sinónimos, errores
 * ortográficos, preguntas parecidas pero no idénticas, ni negaciones: «no es una emergencia» deriva igual
 * (dirección segura). Tampoco cubre guiones o puntuación dentro de una palabra («sui-cidio», «acci.dente»), formas
 * pronominales («matarme»), leetspeak («acc1dente»), letras separadas por espacios ni palabras pegadas. La red de
 * seguridad para las emergencias que el enrutador no detecte es el carril IA (H4). Tampoco decide si encender
 * `carrilFijo` es prudente: eso exige una medición (pendiente).
 */
import type { Enrutador } from '../configuracion/esquema.js';
import type { BancoRespuestas, MotivoDerivacion, Riesgo } from './esquema.js';
import { normalizarParaTerminos, normalizarParaTerminosSeparado, normalizarPregunta } from './esquema.js';

export const CARRILES = ['fijo', 'derivacion', 'ia'] as const;
export type Carril = (typeof CARRILES)[number];

export const MOTIVOS_IA = ['enrutador_apagado', 'sin_contenido', 'sin_coincidencia', 'carril_fijo_apagado'] as const;
export type MotivoIa = (typeof MOTIVOS_IA)[number];

export const ORIGENES_DERIVACION = ['termino_emergencia', 'pregunta_derivacion', 'condicion_entrada'] as const;
export type OrigenDerivacion = (typeof ORIGENES_DERIVACION)[number];

export interface DecisionFijo {
  carril: 'fijo';
  entradaId: string;
  tema: string;
  riesgo: Riesgo;
}
export interface DecisionDerivacion {
  carril: 'derivacion';
  motivo: MotivoDerivacion;
  origen: OrigenDerivacion;
  entradaId: string;
}
export interface DecisionIa {
  carril: 'ia';
  motivo: MotivoIa;
  entradaCandidata: string | null;
}
export type DecisionEnrutador = DecisionFijo | DecisionDerivacion | DecisionIa;

/** Estado de la conversación que el enrutador necesita; lo aporta quien lo conecte (H4). */
export interface EstadoEnrutador {
  atencionHumanaSolicitada: boolean;
}

export interface TerminoIndexado {
  /** Derivación (posición en `banco.derivaciones`) a la que pertenece el término. */
  derivacion: number;
  /** Orden en el banco: ante varias coincidencias deriva la primera. */
  orden: number;
}

export interface IndiceEnrutador {
  banco: BancoRespuestas;
  preguntas: ReadonlyMap<string, { tipo: 'respuesta' | 'derivacion'; posicion: number }>;
  /** Términos por su texto normalizado (palabras separadas por un espacio). Si dos se repiten, queda el primero. */
  terminos: ReadonlyMap<string, TerminoIndexado>;
  /** Cantidades de palabras que tienen los términos (para buscar solo grupos de esos tamaños). */
  longitudes: ReadonlyArray<number>;
}

export function prepararEnrutador(banco: BancoRespuestas): IndiceEnrutador {
  const preguntas = new Map<string, { tipo: 'respuesta' | 'derivacion'; posicion: number }>();
  const terminos = new Map<string, TerminoIndexado>();
  const longitudes = new Set<number>();
  const registrar = (lista: readonly string[], tipo: 'respuesta' | 'derivacion', posicion: number) => {
    for (const p of lista) {
      const clave = normalizarPregunta(p);
      if (!preguntas.has(clave)) preguntas.set(clave, { tipo, posicion });
    }
  };
  // Primero las derivaciones: ante una pregunta duplicada gana la derivación, como en el orden de decisión.
  let orden = 0;
  banco.derivaciones.forEach((e, i) => {
    registrar(e.preguntas, 'derivacion', i);
    for (const t of e.terminos) {
      const n = normalizarParaTerminos(t);
      if (n === '') continue;
      if (!terminos.has(n)) terminos.set(n, { derivacion: i, orden });
      orden++;
      longitudes.add(n.split(' ').length);
    }
  });
  banco.respuestas.forEach((e, i) => registrar(e.preguntas, 'respuesta', i));
  return { banco, preguntas, terminos, longitudes: [...longitudes].sort((x, y) => x - y) };
}

/**
 * Término de emergencia que coincide, el primero según el orden del banco. Compara cada grupo de palabras
 * consecutivas del mensaje (de los tamaños que existen en el banco) contra el mapa de términos: el costo crece
 * con el largo del mensaje y no con la cantidad de términos.
 */
function buscarTermino(nt: string, indice: IndiceEnrutador): TerminoIndexado | null {
  const palabras = nt.split(' ');
  let mejor: TerminoIndexado | null = null;
  for (const largo of indice.longitudes) {
    for (let i = 0; i + largo <= palabras.length; i++) {
      const t = indice.terminos.get(largo === 1 ? (palabras[i] ?? '') : palabras.slice(i, i + largo).join(' '));
      if (t && (mejor === null || t.orden < mejor.orden)) mejor = t;
    }
  }
  return mejor;
}

export function enrutar(texto: string, indice: IndiceEnrutador, config: Enrutador, estado: EstadoEnrutador): DecisionEnrutador {
  if (!config.activo) return { carril: 'ia', motivo: 'enrutador_apagado', entradaCandidata: null };

  // Dos variantes: invisible dentro de una palabra (se borra) e invisible como separador (vale un espacio).
  const dentro = normalizarParaTerminos(texto);
  const separado = normalizarParaTerminosSeparado(texto);
  if (dentro === '' && separado === '') return { carril: 'ia', motivo: 'sin_contenido', entradaCandidata: null };

  const a = dentro === '' ? null : buscarTermino(dentro, indice);
  const b = separado === '' || separado === dentro ? null : buscarTermino(separado, indice);
  const t = a !== null && b !== null ? (a.orden <= b.orden ? a : b) : (a ?? b);
  if (t !== null) {
    const d = indice.banco.derivaciones[t.derivacion];
    if (d) return { carril: 'derivacion', motivo: d.motivo, origen: 'termino_emergencia', entradaId: d.id };
  }

  const hallada = indice.preguntas.get(normalizarPregunta(texto));
  if (hallada?.tipo === 'derivacion') {
    const d = indice.banco.derivaciones[hallada.posicion];
    if (d) return { carril: 'derivacion', motivo: d.motivo, origen: 'pregunta_derivacion', entradaId: d.id };
  }
  if (hallada?.tipo === 'respuesta') {
    const r = indice.banco.respuestas[hallada.posicion];
    if (r) {
      if (!config.carrilFijo) return { carril: 'ia', motivo: 'carril_fijo_apagado', entradaCandidata: r.id };
      if (r.derivar_cuando.includes('contenido_pendiente')) {
        return { carril: 'derivacion', motivo: 'contenido_pendiente', origen: 'condicion_entrada', entradaId: r.id };
      }
      if (r.derivar_cuando.includes('atencion_humana_solicitada') && estado.atencionHumanaSolicitada) {
        return { carril: 'derivacion', motivo: 'atencion_humana_ya_solicitada', origen: 'condicion_entrada', entradaId: r.id };
      }
      return { carril: 'fijo', entradaId: r.id, tema: r.tema, riesgo: r.riesgo };
    }
  }

  return { carril: 'ia', motivo: 'sin_coincidencia', entradaCandidata: null };
}

/** Avisos para la bitácora: solo ids y enumerados. Jamás un término ni texto de la persona. */
export function avisosDecision(d: DecisionEnrutador): string[] {
  const avisos = [`carril:${d.carril}`];
  if (d.carril === 'fijo') avisos.push(`respuesta_fija:${d.entradaId}`, `riesgo:${d.riesgo}`);
  else if (d.carril === 'derivacion') avisos.push(`derivacion:${d.motivo}`, `origen:${d.origen}`, `entrada:${d.entradaId}`);
  else {
    avisos.push(`motivo_ia:${d.motivo}`);
    if (d.entradaCandidata !== null) avisos.push(`candidata:${d.entradaCandidata}`);
  }
  return avisos;
}
