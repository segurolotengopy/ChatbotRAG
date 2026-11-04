/**
 * INTERPRETACIÓN Y CONTROL DE LA SALIDA DE KUAA
 *
 * El puerto del proveedor no permite pedir JSON con esquema, así que el modelo responde un objeto
 * JSON dentro del texto. Acá se acepta SOLO un único objeto (opcionalmente en un bloque de código
 * marcado json) que cumpla `SalidaOportunidad`; cualquier otra cosa es inválida y el agente cae al
 * mensaje de error temporal. Nunca se entrega texto del modelo sin validar.
 *
 * Los detectores (`contieneEnlaceOPrecio`, `afirmaHechoNoRespaldado`, `filtraPrompt`) son deterministas y
 * conservadores: prefieren descartar a dejar pasar. Qué NO garantizan: atrapar toda paráfrasis; dan falsos
 * positivos a propósito (por ejemplo, un número con separador de miles que no es un precio).
 */
import type { ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { BotonSalida, ObjecionSalida, PropuestaSalida, SalidaOportunidad, type EstadosOperativos, type EtapaVenta } from './esquemas.js';
import { formatearTelefono } from './formato-plataforma.js';
import { contieneEnlaceOPrecio, paraDetectar, patronEnlaceOPrecio, permitidosDe, type Permitidos } from './detector-enlace-precio.js';

export { contieneEnlaceOPrecio, patronEnlaceOPrecio, permitidosDe, type Permitidos };

const RE_BLOQUE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;

/** Por qué una salida del modelo no sirvió. Solo códigos y nombres de campo del esquema: jamás texto del modelo. */
export type CausaSalidaInvalida = 'sin_objeto' | 'json_roto' | `esquema:${string}`;

export function analizarSalida(texto: string): { salida: SalidaOportunidad; descartados: number } | { causa: CausaSalidaInvalida } {
  let cuerpo = texto.trim();
  const bloque = RE_BLOQUE.exec(cuerpo);
  if (bloque?.[1] !== undefined) cuerpo = bloque[1].trim();
  if (!cuerpo.startsWith('{') || !cuerpo.endsWith('}')) return { causa: 'sin_objeto' };
  let valor: unknown;
  try {
    valor = JSON.parse(cuerpo);
  } catch {
    return { causa: 'json_roto' };
  }
  // Un botón o una propuesta fuera del enumerado no vale ni se ejecuta: se descarta en vez de fallar toda la respuesta
  // con «problema técnico» (la batería de SLT lo vio con «tengo 64 años, ¿puedo?»). Solo se cuenta, jamás se guarda.
  let descartados = 0;
  if (typeof valor === 'object' && valor !== null && !Array.isArray(valor)) {
    const o = valor as Record<string, unknown>;
    // Un campo desconocido en la raíz (el modelo agrega «razonamiento» o «notas») no puede tumbar la respuesta
    // (`esquema:raiz` en la batería de SLT): se descarta y se cuenta. Una `objecion` ausente es «sin objeción».
    for (const clave of Object.keys(o)) {
      if (!['texto', 'etapa_propuesta', 'objecion', 'botones', 'propuestas'].includes(clave)) {
        delete o[clave];
        descartados += 1;
      }
    }
    if (o['objecion'] === undefined) o['objecion'] = null;
    // Una objeción con código o estado fuera del enumerado tampoco tumba la respuesta (`esquema:objecion.codigo` en la
    // corrida de SLT del 3-nov): se toma como «sin objeción» y se cuenta, sin guardar el valor.
    else if (o['objecion'] !== null && !ObjecionSalida.safeParse(o['objecion']).success) {
      o['objecion'] = null;
      descartados += 1;
    }
    for (const [clave, permitido] of [['botones', BotonSalida.options], ['propuestas', PropuestaSalida.options]] as const) {
      const lista = o[clave];
      // Un campo ausente o nulo equivale a «sin botones/propuestas»: el modelo suele omitirlo cuando no propone nada, y
      // eso tumbaba toda la respuesta con «problema técnico» (R06 y R09 de la batería de SLT: `esquema:propuestas`).
      if (lista === undefined || lista === null) {
        o[clave] = [];
        continue;
      }
      if (!Array.isArray(lista)) continue;
      const validos = lista.filter((x) => typeof x === 'string' && (permitido as readonly string[]).includes(x));
      descartados += lista.length - validos.length;
      o[clave] = validos;
    }
  }
  const r = SalidaOportunidad.safeParse(valor);
  if (r.success) return { salida: r.data, descartados };
  // Del primer problema solo viaja la ruta si sus partes son claves simples o índices; lo demás es dato del modelo.
  const ruta = (r.error.issues[0]?.path ?? []).map((p) => (typeof p === 'number' || (typeof p === 'string' && /^[a-z_]{1,30}$/.test(p)) ? String(p) : '?')).join('.');
  return { causa: `esquema:${ruta === '' ? 'raiz' : ruta}` };
}

export function interpretarSalidaModelo(texto: string): SalidaOportunidad | null {
  const a = analizarSalida(texto);
  return 'salida' in a ? a.salida : null;
}

const MARCA_DE_CASO = /\b(?:(?:tu|tus|su|sus|mi|vuestra|esta|esa|nuestra)\s{1,3}poliza|ya|hoy|ahora|ayer|recien|listo|lista|vigente|para\s{1,3}(?:vos|ti|usted)|a\s{1,3}(?:tu|su)\s{1,3}nombre|(?:te|le)\s{1,3}llego)\b/;
const PEDIDO = '(?:tu|su|el)\\s{1,3}pedido(?:\\s{1,3}y\\s{1,3}(?:tus|sus|las)\\s{1,3}declaraciones)?|(?:tus|sus|las)\\s{1,3}declaraciones';
const CONDICIONES = '(?:las\\s{1,3})?condiciones(?:\\s{1,3}(?:aplicables(?:\\s{1,3}a\\s{1,3}(?:tu|su)\\s{1,3}contrato)?|del\\s{1,3}contrato|de\\s{1,3}(?:tu|su)\\s{1,3}contrato))?';
const EMITE = 'es\\s{1,3}emitida\\s{1,3}por\\s{1,3}(?:la\\s{1,3})?(?:aseguradora|compania(?:\\s{1,3}aseguradora)?)';
// Plazo cerrado que da el modelo al explicar cuándo se emite: «una vez aprobada la solicitud y acreditado el pago».
const PLAZO = '(?:\\s{1,3}(?:una\\s{1,3}vez|despues\\s{1,3}de)\\s{1,3}aprobada\\s{1,3}la\\s{1,3}solicitud(?:\\s{1,3}y\\s{1,3}acreditado\\s{1,3}el\\s{1,3}pago)?)?';
const ORACION_PERMITIDA = new RegExp(
  `^\\s*(?:no,?\\s{1,3})?(?:la|una)\\s{1,3}solicitud\\s{1,3}(?:es|reune|incluye)\\s{1,3}(?:${PEDIDO})(?:\\s{0,3}[,;:]\\s{0,3}(?:mientras\\s{1,3}que\\s{1,3}|y\\s{1,3})?|\\s{1,3}y\\s{1,3})(?:la|una)\\s{1,3}poliza\\s{1,3}${EMITE}${PLAZO}(?:\\s{1,3}y\\s{1,3}contiene\\s{1,3}${CONDICIONES})?\\s{0,3}[.!]{0,3}\\s{0,3}$`,
);
const FRASE_DE_EMISION = new RegExp(`(?<=poliza\\s{1,3})${EMITE}`);
const DICE_EMISION = /\b(?:emitid[oa]s?|activad[oa]s?|activa|emitieron)\b/;

/**
 * «La póliza es emitida por la aseguradora» describe qué es una póliza (quién la emite), no afirma que la de esta
 * persona ya exista: así lo dice el modelo al explicar la diferencia con la solicitud (TCV062). Es una LISTA DE
 * PERMITIDOS cerrada: la frase se quita solo si la oración COMPLETA tiene la forma «[No,] la solicitud
 * (es|reúne|incluye) <tu pedido [y tus declaraciones]> (, | ; | : | y | , mientras que) la póliza es emitida por
 * (la) aseguradora [una vez aprobada la solicitud y acreditado el pago] [y contiene (las) condiciones [aplicables / del contrato]]»; y, además, en TODO el texto no hay
 * marca de caso («tu/su/mi/esta póliza», «ya», «hoy», «ahora», «vigente», «para vos», «a tu nombre», «te llegó»…).
 * Cualquier otra oración, aunque diga lo mismo con otras palabras, se juzga con la lógica de siempre (bloquea como
 * antes). Se deja la palabra «póliza» para que lo que siga se lea como antes. Qué NO garantiza: aceptar otras
 * redacciones legítimas (quedan bloqueadas, que es el lado seguro) ni que la frase, dicha de una persona concreta sin
 * ninguna marca, no sea en su contexto una afirmación. Si tras quitarla el texto aún dice «emitida» o «activada» en
 * cualquier otra oración, no se quita nada.
 */
function quitarDescripcionGeneralDePoliza(t: string): string {
  if (!t.includes('es emitida por') || MARCA_DE_CASO.test(t)) return t;
  const sinFrase = t
    .split(/(?<=[.!?])/)
    .map((oracion) => (ORACION_PERMITIDA.test(oracion) ? oracion.replace(FRASE_DE_EMISION, '') : oracion))
    .join('');
  // Si, sin la frase, el texto aún habla de emisión o activación (otra oración: «En tu caso, fue emitida»), rige main.
  return DICE_EMISION.test(sinFrase) ? t : sinFrase;
}

export type MotivoHecho = 'pago' | 'poliza' | 'agenda_o_traspaso' | 'cobertura' | 'indemnizacion';

/**
 * El asistente no puede afirmar como HECHO lo que solo el sistema sabe: un pago acreditado, una póliza
 * emitida, un seguimiento agendado, un traspaso, una cobertura o elegibilidad. Con el estado que SLT informa
 * en la misma petición, un pago acreditado o una póliza emitida SÍ pueden mencionarse. Devuelve el motivo o
 * null. Qué NO garantiza: detecta las formas que su expresión conoce (voseo, tuteo y usted), no toda paráfrasis.
 */
export function afirmaHechoNoRespaldado(texto: string, estados: EstadosOperativos): MotivoHecho | null {
  const t = paraDetectar(texto);
  if (estados.pago !== 'acreditado') {
    if (/\b(?:pago|cuota|cobro)\b[^.!?]{0,40}\b(?:acreditad[oa]s?|confirmad[oa]s?|cobrad[oa]s?|recibid[oa]s?)\b/.test(t)) return 'pago';
    if (/\b(?:cobramos|acreditamos|recibimos\s+(?:tu|su)\s+pago)\b/.test(t)) return 'pago';
  }
  if (estados.poliza !== 'emitida') {
    // «La póliza todavía no fue emitida» o «será emitida» no afirman un hecho: se ignoran los tramos con negación o futuro.
    const m = /\bpoliza\b([^.!?]{0,40})\b(?:emitid[oa]|activad[oa])\b/.exec(quitarDescripcionGeneralDePoliza(t));
    if (m && !/\b(?:no|ni|nunca|todavia|aun|sera|seran|cuando|una\s+vez|despues)\b/.test(m[1] ?? '')) return 'poliza';
    if (/\b(?:emitimos|activamos)\b/.test(t)) return 'poliza';
  }
  if (/\bqued(?:o|aron)\s+(?:ya\s+)?(?:agendad|programad|activad)/.test(t)) return 'agenda_o_traspaso';
  if (/\b(?:te|le)\s+agende\b|\b(?:te|le)\s+transferi\b|\b(?:te|le)\s+derivo\s+ahora\b/.test(t)) return 'agenda_o_traspaso';
  if (/\bestas\s+cubiert[oa]\b|\bsos\s+elegible\b|\bqued(?:o|aron)\s+aprobad[oa]/.test(t)) return 'cobertura';
  if (/\b(?:te|le)\s+garantizo\b[^.!?]{0,80}indemniz|\b(?:te|le)\s+vamos\s+a\s+pagar\s+la\s+indemnizacion/.test(t)) return 'indemnizacion';
  return null;
}

/**
 * Fugas del prompt: encabezados de las instrucciones o frases que las citan. Los encabezados se comparan en
 * mayúsculas porque «reglas» es una palabra común. Qué NO garantiza: una fuga parafraseada.
 */
export function filtraPrompt(texto: string): boolean {
  const limpio = texto.normalize('NFKC').replace(/\p{Cf}/gu, '');
  if (/\b(?:REGLAS|JERARQUÍA DE FUENTES|CONTEXTO DE LA OPORTUNIDAD|FORMATO DE SALIDA|INICIO DE DATOS|REGLAS DE KUAA)\b/.test(limpio)) return true;
  return /mis\s+instrucciones\s+dicen|jerarquia\s+de\s+fuentes|reglas\s+de\s+kuaa/.test(paraDetectar(limpio));
}

/**
 * Respuesta cuando el detector bloquea enlaces, teléfonos o importes: antes era el «problema técnico», que no
 * explicaba nada y hacía repetir la pregunta. Frase fija y neutra (sin segunda persona, para valer con voseo, tuteo
 * o usted). Qué NO garantiza: que la persona reciba el dato; solo que no se le diga que hubo una falla.
 */
export const TEXTO_SIN_CIFRAS = 'Los precios, montos, teléfonos y enlaces no los puedo dar por este medio. Una persona del equipo puede ayudar con eso.';

export function salidaSinCifras(etapa: EtapaVenta, whatsappE164?: string): SalidaOportunidad {
  const texto = whatsappE164 === undefined ? TEXTO_SIN_CIFRAS : `Ese dato no lo puedo dar por este medio. Podés escribir al WhatsApp ${formatearTelefono(whatsappE164)} y una persona del equipo te ayuda.`;
  return { texto, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
}

/**
 * Quita las frases en que el asistente promete entregar algo que no puede hacer («te preparo un resumen», «te envío
 * el detalle»). Devuelve el texto sin ellas; vacío si no quedaba otra cosa. Qué NO garantiza: promesas con otra forma.
 */
export function quitarPromesasDeEntrega(texto: string): string {
  const PROMESA = /\b(?:te|le)\s+(?:preparo|armo|envio|mando|paso|genero)\b[^.!?]{0,40}\b(?:resumen|informe|documento|detalle|comprobante|cotizacion|propuesta)|\b(?:preparo|armo|genero)\s+(?:un|el)\s+(?:resumen|informe|detalle)|\b(?:queres|quieres|te\s+muestro|puedo\s+mostrarte)\b[^.!?]{0,60}\b(?:documentacion|informacion\s+institucional|quien\s+asegura)/;
  return texto
    .split(/(?<=[.!?])\s+/)
    .filter((frase) => !PROMESA.test(paraDetectar(frase)))
    .join(' ')
    .trim();
}

/**
 * Quita las frases para las que `debeQuitarse` es verdadero (se compara cada frase sola). Sirve para sacar una
 * frase con un enlace o un hecho no respaldado y conservar el resto de la respuesta en vez de reemplazarla entera por un
 * texto genérico. Devuelve vacío si no quedaba nada. Qué NO garantiza: el resto se vuelve a revisar por quien llama.
 */
export function quitarFrases(texto: string, debeQuitarse: (frase: string) => boolean): string {
  return texto
    .split(/(?<!\bGs)(?<=[.!?])\s+/)
    .filter((frase) => !debeQuitarse(frase))
    .join(' ')
    .trim();
}

/**
 * Intenta salvar una respuesta bloqueada quitando lo que la bloquea: primero por frases y, si eso deja muy poco, por
 * cláusulas (separadas por coma, punto y coma o «pero»), de modo que «El premio es Gs. 390.000 por año, no diez mil.»
 * conserve la primera parte. Devuelve el texto que queda solo si tiene al menos `minimo` caracteres y `bloqueado` ya
 * no lo marca; si no, null y quien llama responde como antes. Qué NO garantiza: que lo que queda diga todo lo que el
 * modelo quería decir; solo que no contiene lo bloqueado.
 */
export function salvarQuitandoBloqueado(texto: string, bloqueado: (fragmento: string) => boolean, minimo: number): string | null {
  // Un resto que termina en «Gs.» o «Gs» quedó sin su importe: no se entrega.
  const ok = (t: string): boolean => t.length >= minimo && !bloqueado(t) && !/\bGs\.?$/i.test(t);
  const porFrases = quitarFrases(texto, bloqueado);
  if (ok(porFrases)) return porFrases;
  // «Gs.» (guaraníes) lleva punto pero no cierra frase: cortar ahí dejaba «...confirmar que Gs.» sin el importe.
  const clausulas = texto.split(/(?<!\bGs)(?<=[.!?;,])\s{1,8}|\s{1,8}pero\s{1,8}/);
  const resto = clausulas.filter((c) => !bloqueado(c)).join(' ').replace(/[,;]\s*$/, '.').trim();
  return ok(resto) ? resto : null;
}

/**
 * Quita el número de matrícula o registro del corredor («matrícula BCP N.o 118»): el dato no está aprobado para
 * citarse hasta que Legal lo confirme (contradicciones del paquete). Deja el resto de la frase. Qué NO garantiza:
 * otros números de registro con otra forma.
 */
export function retirarNumerosDeRegistro(texto: string): string {
  return texto
    .replace(/(?:,|\s{1,3}(?:con|de|bajo))?\s{0,3}matr[ií]cula\s{1,3}(?:bcp\s{1,3})?(?:n\.?\s{0,3}[o°º]\.?\s{0,3})?\d{1,6}/giu, '')
    .replace(/,?\s{0,3}\bBCP\s{1,3}n\.?\s{0,3}[o°º]\.?\s{0,3}\d{1,6}/giu, '')
    .replace(/ {1,3}([.,;!?])/g, '$1')
    .trim();
}

/**
 * El tratamiento tributario del premio (IVA, impuestos, exención) está pendiente de Contabilidad, Legal y la
 * aseguradora (contradicción C14 del paquete): Kuaa solo informa el premio total publicado. Frase provisional de
 * Rodrigo, para cuando se pregunta por el tratamiento más allá de «IVA incluido»; sin segunda persona de verbo, para valer con voseo, tuteo o usted.
 */
export const TEXTO_TRIBUTARIO = 'Puedo informar el premio total publicado; para el tratamiento tributario y la factura te orientamos con Interseguros.';

/**
 * Detecta afirmaciones tributarias que no están respaldadas: «más IVA», «sin IVA», exento, gravado, impuestos,
 * desglose, prima neta, alícuota o «por ciento». La ÚNICA frase permitida es «IVA incluido» (con o sin «con»),
 * que es lo que las pantallas de SLT ya muestran al lado del premio total; el desglose sigue pendiente
 * (contradicción C14). Una negación antes («sin», «no», «más») la vuelve a bloquear. Qué NO garantiza: paráfrasis
 * sin esas palabras («ya trae todo»).
 */
export function afirmaTratamientoTributario(texto: string): boolean {
  const t = paraDetectar(texto).replace(/(?<!\b(?:sin|no|mas)\s{1,3}(?:(?:es|esta|viene|va|con)\s{1,3})?)\b(?:con\s+)?iva\s+incluido\b/g, ' ');
  return /\biva\b|\bimpuestos?\b|\bexent[oa]s?\b|\bgravad[oa]s?\b|\bimponible|\bdesglose|\bprima\s+neta|\balicuota|\bpor\s+ciento/.test(t);
}

export function salidaTributaria(etapa: EtapaVenta): SalidaOportunidad {
  return { texto: TEXTO_TRIBUTARIO, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
}

/**
 * Quita el «¡Hola!» con que el modelo abre una respuesta cuando la persona NO saludó (o cuando ya hubo mensajes antes):
 * la regla del prompt lo pide («saludar solo en el primer mensaje») pero el modelo la ignora (12 de 135 respuestas en la
 * corrida de SLT del 4-nov), así que se hace de forma determinista. Solo quita un saludo EXACTO al inicio: «Hola» como
 * palabra completa seguida de «!», «,» o «.» (o fin de texto), con o sin un nombre propio de hasta tres palabras
 * antes del cierre («¡Hola, Juan!», «¡Hola, María José!»); y solo si queda una respuesta de al menos `minimo`
 * caracteres. En cualquier otro caso devuelve el texto sin tocar («Holanda…», «Hola.com», «Hola cómo estás…»).
 * Qué NO garantiza: otros saludos («Buen día»), ni uno a mitad de texto.
 */
export function quitarSaludoInicial(texto: string, mensajePersona: string, hayHistorial: boolean, minimo: number): string {
  const personaSaluda = /\b(?:hola|buen\s{1,3}dia|buen[oa]s|saludos|hey|que\s{1,3}tal|mba'?eichapa)\b/.test(paraDetectar(mensajePersona));
  if (personaSaluda && !hayHistorial) return texto;
  const saludo = /^\s*¡?[Hh]ola(?![\p{L}\p{M}\p{N}.])(?:,?\s+\p{Lu}\p{L}{1,14}(?:\s+\p{Lu}\p{L}{1,14}){0,2}(?=\s*[!.,])|(?=\s*[!,.]|\s*$))\s*[!,.]\s*/u;
  const m = saludo.exec(texto);
  if (!m) return texto;
  const resto = texto.slice(m[0].length).trimStart();
  if (resto.length < minimo) return texto;
  return resto.charAt(0).toLocaleUpperCase('es') + resto.slice(1);
}

/**
 * Retira referencias a códigos internos del paquete (una letra mayúscula y dos dígitos): los que van entre
 * paréntesis y los que siguen a «según», «ver» o «código». Un código suelto («vitamina B12») o pegado a un punto,
 * arroba o barra («x.A12.py») NO se toca, para no alterar texto legítimo ni esconder un dominio al detector.
 * Qué NO garantiza: códigos con otra forma o sin esas palabras; el texto puede quedar algo seco. Los
 * `(?<![ \t])` hacen que cada tirada de espacios se examine una sola vez: sin ellos, una respuesta con miles de
 * espacios seguidos costaba tiempo cuadrático (alerta `js/polynomial-redos` de CodeQL).
 */
export function retirarCodigosInternos(texto: string): string {
  return texto
    .replace(/(?<![ \t])[ \t]*\([A-Z]\d{2}(?:[ \t]*[,;][ \t]*[A-Z]\d{2})*\)/g, '')
    .replace(/(?<![.@/\w-])(?:[Ss]egún|[Vv]er|[Cc]ódigo)[ \t]+[A-Z]\d{2}(?![\w@/-])(?!\.\w)[ \t]*/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/(?<![ \t])[ \t]+([.,;:])/g, '$1')
    .trim();
}

export function salidaFallback(config: ConfiguracionEfectiva, etapa: EtapaVenta): SalidaOportunidad {
  return { texto: config.mensajes.errorTemporal, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
}
