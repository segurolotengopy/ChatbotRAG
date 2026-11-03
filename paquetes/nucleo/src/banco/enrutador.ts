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
 * con `includes` sobre texto normalizado y rodeado de espacios, de modo que no hay ReDoS posible.
 *
 * Qué NO garantiza: homóglifos de otros alfabetos (una «е» cirílica evita un término), sinónimos, errores
 * ortográficos, preguntas parecidas pero no idénticas, ni negaciones: «no es una emergencia» deriva igual
 * (dirección segura). Tampoco decide si encender `carrilFijo` es prudente: eso exige una medición (pendiente).
 */
import type { Enrutador } from '../configuracion/esquema.js';
import type { BancoRespuestas, MotivoDerivacion, Riesgo } from './esquema.js';
import { normalizarParaTerminos, normalizarPregunta } from './esquema.js';

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

export interface IndiceEnrutador {
  banco: BancoRespuestas;
  preguntas: ReadonlyMap<string, { tipo: 'respuesta' | 'derivacion'; posicion: number }>;
  /** `buscado` es el término normalizado y rodeado de espacios; `derivacion` es la posición en `banco.derivaciones`. */
  terminos: ReadonlyArray<{ buscado: string; derivacion: number }>;
}

export function prepararEnrutador(banco: BancoRespuestas): IndiceEnrutador {
  const preguntas = new Map<string, { tipo: 'respuesta' | 'derivacion'; posicion: number }>();
  const terminos: { buscado: string; derivacion: number }[] = [];
  const registrar = (lista: readonly string[], tipo: 'respuesta' | 'derivacion', posicion: number) => {
    for (const p of lista) {
      const clave = normalizarPregunta(p);
      if (!preguntas.has(clave)) preguntas.set(clave, { tipo, posicion });
    }
  };
  banco.respuestas.forEach((e, i) => registrar(e.preguntas, 'respuesta', i));
  banco.derivaciones.forEach((e, i) => {
    registrar(e.preguntas, 'derivacion', i);
    for (const t of e.terminos) {
      const n = normalizarParaTerminos(t);
      if (n !== '') terminos.push({ buscado: ` ${n} `, derivacion: i });
    }
  });
  return { banco, preguntas, terminos };
}

export function enrutar(texto: string, indice: IndiceEnrutador, config: Enrutador, estado: EstadoEnrutador): DecisionEnrutador {
  if (!config.activo) return { carril: 'ia', motivo: 'enrutador_apagado', entradaCandidata: null };

  const nt = normalizarParaTerminos(texto);
  if (nt === '') return { carril: 'ia', motivo: 'sin_contenido', entradaCandidata: null };

  // Filtro barato: un término solo puede coincidir si su primera palabra está entre las del mensaje.
  const palabras = new Set(nt.split(' '));
  const rodeado = ` ${nt} `;
  for (const t of indice.terminos) {
    if (!palabras.has(t.buscado.slice(1, t.buscado.indexOf(' ', 1))) || !rodeado.includes(t.buscado)) continue;
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
