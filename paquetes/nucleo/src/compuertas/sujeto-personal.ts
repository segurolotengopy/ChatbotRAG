/**
 * SUJETO PERSONAL EN SALUD Y PEP (criterio `sin_sujeto`)
 *
 * Porqué: `esPreguntaGeneral` deja pasar cualquier texto con «?». Una declaración de
 * salud o de condición PEP escrita como pregunta («me detectaron un tumor, ¿me cubren?»,
 * «fui PEP hasta el año pasado, ¿me afecta?») evadía la compuerta y viajaba al modelo y a
 * la memoria: es el hallazgo HIGH sobre la regla inviolable #7 (los datos de salud y la
 * condición PEP no salen hacia servicios de IA).
 *
 * Defecto que corrige: el signo de pregunta no distingue entre «¿cubre cáncer?» (consulta
 * sobre el producto) y «¿me cubre mi cáncer?» (dato personal). Acá la regla se invierte:
 * con vocabulario de salud o de PEP, el mensaje se bloquea SALVO que sea una pregunta
 * única, corta, que abre con una palabra de una lista cerrada y no lleva marcas de
 * persona ni de tiempo. Falla hacia lo seguro: lo que no abre con la lista se bloquea,
 * porque el español omite el sujeto («era ministro, ¿puedo contratar?»).
 *
 * Qué NO garantiza: reduce, no elimina. Bloquea las declaraciones de salud o PEP que usan
 * el vocabulario conocido, aunque vengan como pregunta; no detecta datos personales
 * escritos sin ese vocabulario ni sin marcas de persona (sinónimos como «biopsia» o
 * «diálisis», diagnósticos impersonales, guaraní o portugués sin vocabulario en español,
 * homóglifos de otros alfabetos, datos repartidos en varios turnos).
 * Tampoco detecta terceros con nombre propio sin cláusula relativa («¿La señora Gómez con
 * diabetes puede contratar?»), ni sinónimos como «diálisis». Falso negativo residual: «de
 * mamá» se admite para no bloquear «cáncer de mama»; «¿Cubre el cáncer de mamá?» pasa.
 * Compromiso: PR de ampliación de vocabulario de salud en 30 días.
 */
import { normalizar } from './vocabulario.js';

/** Cortesías que se descartan antes de mirar cómo abre la pregunta. */
const PREFIJO_CORTESIA =
  /^(?:(?:hola|buenas tardes|buenas noches|buenos dias|buenas|disculpe|disculpa|perdon|una consulta|consulta|pregunta|quiero saber|quisiera saber|queria saber|necesito saber|me gustaria saber)\b[\s,.!:;]*)+/;

/** Lista cerrada de aperturas admitidas: interrogativos, artículos y verbos del producto en tercera persona. */
const APERTURA =
  /^(que|como|cual|cuales|cuanto|cuanta|cuantos|cuantas|por que|para que|donde|cuando|quien|quienes|desde que|hasta que|a partir de que|se|el|la|los|las|un|una|o|os|a|as|este|esta|ese|esa|cubre|cubren|incluye|incluyen|excluye|excluyen|hay|existe|existen|es|son|estan|tiene|tienen|puede|pueden|paga|pagan|aplica|aplican|si)\b/;

/**
 * Excepción estrecha: «¿Me cubre el cáncer…?» equivale, en información, a «¿cubre
 * cáncer?». Se usa solo en `replace`, por eso lleva la bandera `g`.
 */
const ME_PRODUCTO = /\bme (cubre|cubren|cubriria|cubririan|paga|pagan|pagaria|pagarian)\b/g;

/** Marcas de persona: pronombres, verbos en primera persona, parientes y terceros. */
const MARCADOR_PERSONAL =
  /\b(me|mi|mis|yo|conmigo|mio|mia|mios|mias|nos|nuestro|nuestra|nuestros|nuestras|nosotros|nosotras|soy|estoy|estuve|estaba|tengo|tuve|tenia|tuviera|tuviese|tendria|padezco|padeci|padecia|padeciera|sufro|sufri|sufria|sufriera|fui|era|fuera|fuese|seria|estuviera|estaria|he|hemos|somos|estamos|tenemos|tuvimos|fuimos|eramos|tomo|tome|fumo|fume|trabajo|trabaje|ejerzo|ejerci|ocupo|ocupe|llevo|acabo|acabamos)\b|\b\w+(ar|er|ir|ando|iendo)(me|nos)\b|\b(papa|papi|mami)\b|(?<!de )\bmama\b|\b(si|porque|ya que|como) (puedo|quiero|necesito|debo|llego a|empiezo|empece|uso|use)\b|\b(un|una) (amigo|amiga|conocido|conocida|familiar|pariente|vecino|vecina|companero|companera|cliente)\b|\b(alguien|una persona|un senor|una senora) que\b/;

/** Anclas de tiempo: un hecho fechado es una historia personal, no una consulta del producto. */
const ANCLA_TEMPORAL =
  /\b(19|20)\d\d\b|\d{1,2}\/\d{1,2}|\bhace (un|una|dos|tres|cuatro|cinco|unos|unas|varios|varias|mucho|poco|\d+)\b|\b(el|este|ese) (ano|mes) (pasado|que viene)\b|\bdesde (hace|el|la|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b|\b(ayer|anteayer|anoche|hoy|manana|recien|actualmente|todavia|aun|lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b|\bsemana (pasada|que viene)\b|\b(enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|octubre|noviembre|diciembre)\b/;

/**
 * Cláusula subordinada sobre la condición: `que` que no es interrogativo («la quimio que
 * inicié»), y `aunque`, `porque` y `mientras`. Solo se admite `que` al inicio o tras una
 * preposición o locución interrogativa. `cuando` solo se admite como primera palabra.
 */
const SUBORDINADA =
  /(?<!^)(?<!\b(?:desde|hasta|a partir de|por|para|de|en|con|sin|cual) )\bque\b|\b(?:aunque|porque|mientras)\b|(?<!^)\bcuando\b/;

/**
 * `si` admitido solo si lo sigue un verbo o un determinante en tercera persona
 * («qué pasa si una persona es PEP», «si cubre…»); «si vivo con VIH» no pasa.
 */
const SI_NO_ADMITIDO =
  /\bsi (?!(?:es|son|esta|estan|cubre|cubren|incluye|incluyen|excluye|excluyen|hay|existe|existen|tiene|tienen|puede|pueden|paga|pagan|aplica|aplican|se|el|la|los|las|un|una|alguien)\b)/;

/** «P E P», «p.e.p», «p·e·p», «p/e/p»: la sigla con separadores, que el vocabulario no ve. */
export const PATRON_PEP_ESPACIADO = /\bp[^a-z0-9]{0,3}e[^a-z0-9]{0,3}p\b/;

/**
 * Quita los caracteres invisibles o combinantes con que se parte una palabra:
 * \p{Mn}, \p{Me}, \p{Cf} (espacio de ancho cero, selectores de variación) y los rellenos
 * Hangul, braille y CGJ; luego recompone. Las tildes también se pierden, como en `normalizar`.
 */
function sinInvisibles(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\p{Mn}\p{Me}\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu, '')
    .normalize('NFKC');
}

/**
 * Texto sobre el que se aplica el vocabulario en `sin_sujeto`: sin invisibles y sin las
 * frases de pago que usan «operación» («Recibimos tu operación»), que no son salud.
 */
export function textoParaVocabularioReforzado(texto: string): string {
  return normalizar(sinInvisibles(texto)).replace(
    /\brecibimos (tu|su) operacion\b(?! (?:de|del|para|en|por|con|que|a)\b)|\boperacion (?:de pago|bancaria)\b|\b(?:numero|codigo|comprobante) de operacion\b/g,
    ' ',
  );
}

/**
 * `true` si el texto es una pregunta única sobre el producto o el procedimiento, sin
 * sujeto personal ni tiempo. Es condición necesaria, no suficiente: además debe pasar
 * `esPreguntaGeneral`, que la compuerta sigue aplicando.
 */
export function esPreguntaDeProductoSinSujeto(texto: string): boolean {
  const t = sinInvisibles(texto).trim();
  if (!t.includes('?') && !t.startsWith('¿')) return false;
  if (t.length > 200) return false;
  if (/[\n\r]/.test(t)) return false;
  const cuerpo = normalizar(t)
    .replace(/^[¿¡\s]+/, '')
    .replace(PREFIJO_CORTESIA, '')
    .replace(/^[¿¡\s]+/, '')
    .replace(/[?!.\s]+$/, '')
    .replace(ME_PRODUCTO, 'cubre');
  if (/[.!;?]/.test(cuerpo)) return false;
  if (!APERTURA.test(cuerpo)) return false;
  if (SUBORDINADA.test(cuerpo) || SI_NO_ADMITIDO.test(cuerpo)) return false;
  if (MARCADOR_PERSONAL.test(cuerpo) || ANCLA_TEMPORAL.test(cuerpo)) return false;
  return true;
}
