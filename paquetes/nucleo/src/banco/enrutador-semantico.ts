/**
 * ENRUTADOR CON SEMÁNTICA (modelo híbrido, H4a)
 *
 * Por qué existe: suma la similitud (H3) a la coincidencia exacta (H2) sin cambiar `enrutar`. Primero corre `enrutar`;
 * solo si da `sin_coincidencia` y hay un índice semántico apto, usa el vector de la consulta y `emparejarSemantico`.
 * Es un núcleo PURO: el embedding lo calcula quien llama (H4d) y lo entrega ya calculado, o informa que falló; aquí
 * no hay red, ni reloj, ni entorno.
 *
 * Defecto que motiva el control: una respuesta fija elegida por similitud sale con la autoridad de «texto aprobado».
 * Por eso (1) la vía semántica exige una calibración vigente (mismo banco, modelo y dimensión, válida, sin proveedor
 * simulado); (2) las respuestas fijas exigen además D4 (control sin confusiones ni falsos positivos); (3) cualquier
 * falla (embebedor, tiempo, vector de otra dimensión, calibración no apta) cae a la IA con un motivo enumerado, nunca
 * a una respuesta fija; (4) las condiciones `derivar_cuando` y el carril fijo apagado se aplican igual que en la vía
 * exacta (`decidirRespuesta`). Una derivación semántica no depende de `carrilFijo` (D1) ni de `fijoApto` (el control sin
 * confusiones ni falsos positivos, que solo bloquea los TEXTOS FIJOS), pero SÍ exige `semanticaApta`, que incluye
 * `valido`; por la coherencia del esquema de la calibración, `valido` implica control sin confusiones ni falsos
 * positivos, así que en la práctica una confusión en el control apaga también las derivaciones semánticas. Se deja así a
 * propósito: una calibración inválida no respalda ninguna propuesta. Frontera de D5 (ampliada): una respuesta CRÍTICA propuesta sin respaldo de D4 (`!fijoApto`) deriva con
 * `contenido_pendiente`; con el carril fijo APAGADO también deriva igual que en la vía exacta (excepción a D1 decidida
 * por Andres, en `decidirRespuesta`), mientras una de riesgo normal va a la IA con su candidata.
 *
 * Sin texto de la persona: el resultado lleva ids, enumerados y la similitud redondeada a milésimas.
 *
 * Qué NO garantiza: que la similitud entienda el dominio (lo acota la calibración), que el vector corresponda al texto
 * (lo promete quien llama), ni que `semantica_no_disponible` signifique un fallo: también es el estado de un agente que
 * aún no configuró la semántica. La caída por error o tiempo del embebedor la informa quien llama con `consulta`.
 */
import type { Enrutador } from '../configuracion/esquema.js';
import type { BancoRespuestas } from './esquema.js';
import type { EventoBitacora } from '../puertos/bitacora.js';
import { verificarCalibracion, umbralesDeCalibracion } from './calibracion.js';
import type { Calibracion } from './calibracion.js';
import { avisosDecision, decidirDerivacion, decidirRespuesta, enrutar } from './enrutador.js';
import type { DecisionEnrutador, DecisionIa, EstadoEnrutador, IndiceEnrutador } from './enrutador.js';
import { ErrorSimilitud, emparejarSemantico } from './similitud.js';
import type { IndiceSemantico } from './similitud.js';

export const VIAS_ENRUTAMIENTO = ['exacta', 'semantica'] as const;
export type ViaEnrutamiento = (typeof VIAS_ENRUTAMIENTO)[number];

/** Material semántico preparado una vez por banco (lo arma quien carga el banco y la calibración). */
export interface ContextoSemantico {
  indice: IndiceSemantico;
  calibracion: Calibracion;
  /** Solo pruebas. */
  admitirSimulado?: boolean;
}

/** Resultado de calcular el embedding de la consulta, informado por quien llama. */
export type ConsultaSemantica = { estado: 'ok'; vector: readonly number[] } | { estado: 'error' } | { estado: 'tiempo' };

/**
 * Todo `entradaId` del índice semántico debe existir en el banco con su tipo. Un índice armado con otro banco (o a
 * mano) no se usa: no se cae en silencio a «no hubo coincidencia». Se calcula una vez por índice y banco.
 */
const COHERENCIA = new WeakMap<IndiceSemantico, { banco: BancoRespuestas; ok: boolean }>();
function indiceCoherente(semantico: IndiceSemantico, banco: BancoRespuestas): boolean {
  const previo = COHERENCIA.get(semantico);
  if (previo?.banco === banco) return previo.ok;
  const respuestas = new Set(banco.respuestas.map((r) => r.id));
  const derivaciones = new Set(banco.derivaciones.map((d) => d.id));
  const ok = semantico.vectores.every((v) => (v.tipo === 'respuesta' ? respuestas : derivaciones).has(v.entradaId));
  COHERENCIA.set(semantico, { banco, ok });
  return ok;
}

export interface ResultadoEnrutamiento {
  decision: DecisionEnrutador;
  /** `exacta`: decidió H2. `semantica`: decidió (o cayó a la IA) la vía semántica. */
  via: ViaEnrutamiento;
  /** Puntaje de la entrada propuesta redondeado a milésimas; `null` si no hubo propuesta. */
  similitud: number | null;
}

const ia = (motivo: DecisionIa['motivo'], entradaCandidata: string | null = null): ResultadoEnrutamiento => ({
  decision: { carril: 'ia', motivo, entradaCandidata },
  via: 'semantica',
  similitud: null,
});

const redondear = (x: number): number => Math.round(x * 1000) / 1000;

export function enrutarConSemantica(
  texto: string,
  indice: IndiceEnrutador,
  config: Enrutador,
  estado: EstadoEnrutador,
  semantica: ContextoSemantico | null,
  consulta: ConsultaSemantica | null,
): ResultadoEnrutamiento {
  const exacta = enrutar(texto, indice, config, estado);
  if (exacta.carril !== 'ia' || exacta.motivo !== 'sin_coincidencia') return { decision: exacta, via: 'exacta', similitud: null };

  if (semantica === null || indice.bancoSha256 === null || !indiceCoherente(semantica.indice, indice.banco)) return ia('semantica_no_disponible');
  const verificacion = verificarCalibracion(semantica.calibracion, {
    bancoSha256: indice.bancoSha256,
    modelo: semantica.indice.modelo,
    dimension: semantica.indice.dimension,
    ...(semantica.admitirSimulado === undefined ? {} : { admitirSimulado: semantica.admitirSimulado }),
  });
  if (!verificacion.semanticaApta) return ia('calibracion_no_apta');
  if (consulta === null) return ia('semantica_no_disponible');
  if (consulta.estado === 'tiempo') return ia('embebedor_tiempo');
  if (consulta.estado === 'error') return ia('embebedor_error');
  if (consulta.vector.length !== semantica.indice.dimension) return ia('embebedor_error');

  let propuesta: ReturnType<typeof emparejarSemantico>;
  try {
    propuesta = emparejarSemantico(consulta.vector, semantica.indice, umbralesDeCalibracion(semantica.calibracion));
  } catch (e) {
    if (e instanceof ErrorSimilitud) return ia('embebedor_error');
    throw e;
  }
  if (propuesta === null) return { decision: exacta, via: 'semantica', similitud: null };
  const similitud = redondear(propuesta.puntaje);

  if (propuesta.tipo === 'derivacion') {
    const d = indice.banco.derivaciones.find((x) => x.id === propuesta.entradaId);
    if (!d) return ia('semantica_no_disponible');
    return { decision: decidirDerivacion(d, 'pregunta_semantica'), via: 'semantica', similitud };
  }

  const r = indice.banco.respuestas.find((x) => x.id === propuesta.entradaId);
  if (!r) return ia('semantica_no_disponible');
  // El carril fijo apagado va primero (`decidirRespuesta`): IA con candidata si el riesgo es normal, derivación si es crítico.
  if (!config.carrilFijo) return { decision: decidirRespuesta(r, config, estado), via: 'semantica', similitud };
  if (!verificacion.fijoApto) {
    // D5 (ampliada): un crítico que la calibración no respalda para texto fijo NO pasa a la IA: deriva con
    // `contenido_pendiente`. Uno de riesgo normal cae a la IA con su candidata.
    if (r.riesgo === 'critico') {
      return { decision: { carril: 'derivacion', motivo: 'contenido_pendiente', origen: 'pregunta_semantica', entradaId: r.id }, via: 'semantica', similitud };
    }
    return { decision: { carril: 'ia', motivo: 'calibracion_no_apta', entradaCandidata: r.id }, via: 'semantica', similitud };
  }
  return { decision: decidirRespuesta(r, config, estado), via: 'semantica', similitud };
}

/**
 * Evento `enrutador` para la bitácora: carril, vía, similitud redondeada, motivo enumerado, latencia y los avisos de
 * `avisosDecision` (ids y enumerados). SIN texto de la persona ni del asistente.
 */
export function eventoEnrutador(
  r: ResultadoEnrutamiento,
  base: Pick<EventoBitacora, 'agenteId' | 'perfilId' | 'conversacionHash' | 'canal'>,
  latenciaMs: number,
): EventoBitacora {
  const d = r.decision;
  const motivo = d.carril === 'fijo' ? undefined : d.motivo;
  return {
    tipo: 'enrutador',
    ...base,
    carril: d.carril,
    via: r.via,
    ...(r.similitud === null ? {} : { similitud: r.similitud }),
    ...(motivo === undefined ? {} : { motivo }),
    latenciaMs: Number.isFinite(latenciaMs) ? Math.max(0, Math.round(latenciaMs)) : 0,
    avisos: avisosDecision(d),
  };
}
