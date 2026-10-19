/**
 * COMPUERTAS DE SALIDA — la lección más cara de NovuChat, en código.
 *
 * «Una prohibición dura no puede vivir en el prompt. Un LLM omite frases por
 * temperatura, truncado o reintento.» Estas funciones corren sobre el texto final
 * del modelo, en TODOS los caminos, y cada una deja constancia en `avisos` de que
 * actuó. El sistema falla hacia el mensaje seguro, nunca hacia el silencio.
 *
 * Cada compuerta es una función pura (texto, contexto) → (texto, aviso | null).
 * Están registradas por nombre para que la configuración pueda activarlas y para
 * que agregar una nueva sea agregar una entrada a la tabla.
 */
import type { CompuertaSalida, ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { normalizar } from './vocabulario.js';

export interface ContextoSalida {
  config: ConfiguracionEfectiva;
}

export interface ResultadoCompuerta {
  texto: string;
  aviso: string | null;
  /** true si la compuerta reemplazó la respuesta por un mensaje fijo (y conviene derivar). */
  reemplazo: boolean;
}

type FuncionCompuerta = (texto: string, ctx: ContextoSalida) => ResultadoCompuerta;

const sinCambio = (texto: string): ResultadoCompuerta => ({ texto, aviso: null, reemplazo: false });

/** El asistente no niega ser una IA (criterio A-5 de NovuChat). */
const NIEGA_IA =
  /(no\s+soy\s+(un[ao]?\s+)?(bot|robot|maquina|programa|inteligencia\s+artificial|ia\b|asistente\s+virtual|automatic[ao])|soy\s+(un[ao]?\s+)?(persona|humano|humana|ser\s+humano)\b|habl(as|a|an)\s+con\s+(un[ao]?\s+)?(persona|humano|humana)\b)/;

const niegaIa: FuncionCompuerta = (texto, ctx) => {
  if (!NIEGA_IA.test(normalizar(texto))) return sinCambio(texto);
  return {
    texto: `Sí, soy ${ctx.config.identidad.nombreAsistente}, un asistente virtual con inteligencia artificial de ${ctx.config.identidad.organizacion}. ¿En qué puedo ayudarle?`,
    aviso: 'niega_ia',
    reemplazo: true,
  };
};

/** Promesas de pago/indemnización o decisiones de siniestro: fuera del alcance de cualquier asistente de seguros. */
const PROMESA =
  /\b(le\s+(vamos\s+a\s+)?pagar(emos|an)?\b|se\s+le\s+(pagara|indemnizara|reembolsara)|(garantiz|asegur)(o|amos)\s+(que\s+)?(el\s+pago|la\s+indemnizacion|el\s+reembolso|la\s+cobertura)|su\s+siniestro\s+(esta|sera|fue)\s+(aprobad|aceptad|cubiert)|tiene\s+derecho\s+a\s+cobrar|le\s+corresponde\s+(la\s+indemnizacion|el\s+pago|cobrar))/;

const promesaIndemnizacion: FuncionCompuerta = (texto, ctx) => {
  if (!PROMESA.test(normalizar(texto))) return sinCambio(texto);
  return {
    texto: `${ctx.config.mensajes.fueraDeAlcance} ${ctx.config.mensajes.derivacion}`.trim(),
    aviso: 'promesa_indemnizacion',
    reemplazo: true,
  };
};

/** Decisiones de elegibilidad/aceptación de un caso particular. */
const ELEGIBILIDAD =
  /\b(usted\s+(es|seria|queda)\s+(elegible|apto|apta|aceptad[oa]|aprobad[oa]|rechazad[oa])|(puede|podra)\s+contratar\s+sin\s+problema|su\s+(caso|solicitud|situacion)\s+(esta|seria|sera|queda)\s+(cubiert[oa]|aprobad[oa]|aceptad[oa]|rechazad[oa])|no\s+(califica|aplica)\s+para\s+(el|este)\s+seguro|(esta|queda)\s+cubiert[oa]\s+(desde\s+ya|en\s+su\s+caso|con\s+su\s+condicion))/;

const decisionElegibilidad: FuncionCompuerta = (texto, ctx) => {
  if (!ELEGIBILIDAD.test(normalizar(texto))) return sinCambio(texto);
  return {
    texto: `${ctx.config.mensajes.fueraDeAlcance} ${ctx.config.mensajes.derivacion}`.trim(),
    aviso: 'decision_elegibilidad',
    reemplazo: true,
  };
};

/** Términos confidenciales declarados en la configuración. */
const datoConfidencial: FuncionCompuerta = (texto, ctx) => {
  const n = normalizar(texto);
  const terminos = ctx.config.seguridad.terminosConfidenciales.map(normalizar).filter((t) => t.length >= 3);
  const filtrado = terminos.find((t) => n.includes(t));
  if (!filtrado) return sinCambio(texto);
  return { texto: `${ctx.config.mensajes.fueraDeAlcance} ${ctx.config.mensajes.derivacion}`.trim(), aviso: 'dato_confidencial', reemplazo: true };
};

/**
 * Promesa de traspaso a una persona. En un canal donde no existe tal traspaso
 * (`contactoHumano.modo = canal`) quita la oración que lo promete y agrega el canal
 * oficial. La batería del 12-oct-2026 midió 40 de 368 respuestas con «derivarle con
 * un asesor humano», 17 sin dar el canal.
 *
 * Qué NO garantiza: detecta solo las formas que esta expresión conoce («le derivo»,
 * «derivarle con un asesor», «un asesor se pondrá en contacto», «pasar la
 * conversación»); otra redacción pasa. Corrige la oración, no reemplaza la respuesta,
 * para no perder la parte útil.
 */
const PROMETE_TRASPASO = new RegExp(
  [
    String.raw`\b(le|lo|la)\s+(derivo|derivamos|derivare|derivaremos|transfiero|transferimos|transferire|comunico|comunicare|pasare|pasamos\s+con|paso\s+con|pongo\s+en\s+contacto|pondre\s+en\s+contacto)\b`,
    String.raw`\bderivar(le|lo|la|se)?\s+(con|a|hacia)\s+(un|una|el|la|nuestro|nuestra)\s+(asesor|persona|agente|ejecutiv|equipo|representante|especialista)`,
    String.raw`\b(un|una|el|la)\s+(asesor\w*|agente|ejecutiv\w*|representante|especialista|persona\s+del\s+equipo)\s+(\S+\s+){0,3}(se\s+pondra\s+en\s+contacto|(lo|le|la)\s+(contactara|llamara|escribira)|se\s+comunicara)`,
    String.raw`\b(pasar|transferir|derivar)(le|lo|la)?\s+(la\s+|su\s+)?(conversacion|consulta|chat)\b`,
    String.raw`\b(su|la)\s+(consulta|conversacion)\s+(pasa|sera\s+(derivada|transferida|pasada))\s+a\b`,
  ].join('|'),
);

const prometeTraspaso: FuncionCompuerta = (texto, ctx) => {
  if (ctx.config.operacion.contactoHumano.modo !== 'canal') return sinCambio(texto);
  const oraciones = texto.split(/(?<=[.!?])\s+|\n+/);
  const buenas = oraciones.filter((o) => !PROMETE_TRASPASO.test(normalizar(o)));
  if (buenas.length === oraciones.length) return sinCambio(texto);
  const derivacion = ctx.config.mensajes.derivacion;
  const base = buenas.join(' ').trim();
  return { texto: base.includes(derivacion) ? base : `${base} ${derivacion}`.trim(), aviso: 'promete_traspaso', reemplazo: false };
};

/** Marcas `[X]` que el modelo inventa se borran; las declaradas se extraen aparte. */
const RE_MARCA = /\[([A-Za-zÁÉÍÓÚÑáéíóúñ_ ]{3,30})\]/g;

export function extraerMarcas(
  texto: string,
  permitidas: readonly string[],
): { texto: string; marcas: string[]; borradas: number } {
  const marcas: string[] = [];
  let borradas = 0;
  const limpio = texto
    .replace(RE_MARCA, (_, m: string) => {
      const clave = normalizar(m).toUpperCase().replace(/\s+/g, '_');
      if (permitidas.includes(clave)) marcas.push(clave);
      else borradas++;
      return '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return { texto: limpio, marcas, borradas };
}

const marcaNoDeclarada: FuncionCompuerta = (texto, ctx) => {
  const { texto: limpio, borradas } = extraerMarcas(texto, ctx.config.seguridad.marcasPermitidas);
  if (borradas === 0) return sinCambio(texto);
  return { texto: limpio, aviso: 'marca_no_declarada', reemplazo: false };
};

/** Del Demo B de NovuChat: un cobro simulado nunca puede presentarse como real. */
const AFIRMA_COBRO =
  /((pago|cobro|transferencia|deposito|abono)\s+(\S+\s+){0,3}(verificad|confirmad|recibid|acreditad|procesad|aprobad|realizad|efectuad|exitos)|ya\s+(recibimos|se\s+acredit|te\s+cobr|le\s+cobr|se\s+cobr))/;
const DICE_SIMULADO = /(simulad|simulacr|demostracion|\bdemo\b|no\s+cobra)/;

const afirmaCobroReal: FuncionCompuerta = (texto) => {
  const n = normalizar(texto);
  if (!AFIRMA_COBRO.test(n) || DICE_SIMULADO.test(n)) return sinCambio(texto);
  return { texto: `${texto}\n\n(Cobro SIMULADO: demostración, sin cobro real.)`, aviso: 'afirma_cobro_real', reemplazo: false };
};

export const COMPUERTAS: Record<CompuertaSalida, FuncionCompuerta> = {
  niega_ia: niegaIa,
  promesa_indemnizacion: promesaIndemnizacion,
  decision_elegibilidad: decisionElegibilidad,
  dato_confidencial: datoConfidencial,
  marca_no_declarada: marcaNoDeclarada,
  afirma_cobro_real: afirmaCobroReal,
  promete_traspaso: prometeTraspaso,
};

/** Orden fijo: primero las que reemplazan (más graves), luego las que corrigen. */
const ORDEN: CompuertaSalida[] = [
  'dato_confidencial',
  'promesa_indemnizacion',
  'decision_elegibilidad',
  'promete_traspaso',
  'niega_ia',
  'afirma_cobro_real',
  'marca_no_declarada',
];

export interface ResultadoSalida {
  texto: string;
  avisos: string[];
  reemplazada: boolean;
}

export function aplicarCompuertasSalida(texto: string, ctx: ContextoSalida): ResultadoSalida {
  const activas = new Set<CompuertaSalida>(ctx.config.seguridad.compuertasSalida);
  // `marca_no_declarada` corre SIEMPRE: una marca inventada nunca debe llegar a una persona.
  activas.add('marca_no_declarada');
  let actual = texto;
  const avisos: string[] = [];
  let reemplazada = false;
  for (const nombre of ORDEN) {
    if (!activas.has(nombre)) continue;
    const r = COMPUERTAS[nombre](actual, ctx);
    if (r.aviso) avisos.push(r.aviso);
    actual = r.texto;
    if (r.reemplazo) {
      reemplazada = true;
      break; // un reemplazo es final: el texto ya es nuestro
    }
  }
  if (actual.trim() === '') {
    avisos.push('respuesta_vacia');
    actual = ctx.config.mensajes.errorTemporal;
  }
  return { texto: actual, avisos, reemplazada };
}
