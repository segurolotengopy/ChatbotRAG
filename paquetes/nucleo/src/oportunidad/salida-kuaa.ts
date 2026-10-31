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
import { normalizarEntradaKuaa } from './normalizar-entrada.js';
import { SalidaOportunidad, type EstadosOperativos, type EtapaVenta } from './esquemas.js';

const RE_BLOQUE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;

/** Por qué una salida del modelo no sirvió. Solo códigos y nombres de campo del esquema: jamás texto del modelo. */
export type CausaSalidaInvalida = 'sin_objeto' | 'json_roto' | `esquema:${string}`;

export function analizarSalida(texto: string): { salida: SalidaOportunidad } | { causa: CausaSalidaInvalida } {
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
  const r = SalidaOportunidad.safeParse(valor);
  if (r.success) return { salida: r.data };
  // Del primer problema solo viaja la ruta si sus partes son claves simples o índices; lo demás es dato del modelo.
  const ruta = (r.error.issues[0]?.path ?? []).map((p) => (typeof p === 'number' || (typeof p === 'string' && /^[a-z_]{1,30}$/.test(p)) ? String(p) : '?')).join('.');
  return { causa: `esquema:${ruta === '' ? 'raiz' : ruta}` };
}

export function interpretarSalidaModelo(texto: string): SalidaOportunidad | null {
  const a = analizarSalida(texto);
  return 'salida' in a ? a.salida : null;
}

/**
 * Texto para detectar: NFKC (ancho completo, U+2024 → «.»), sin caracteres de formato, homóglifos plegados,
 * minúsculas y sin tildes. Solo sirve para comparar; jamás se devuelve a la persona.
 */
function paraDetectar(texto: string): string {
  return normalizarEntradaKuaa(texto)
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase();
}

const NUMERO_EN_PALABRAS =
  '(?:un|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|quince|veinte|treinta|cuarenta|cincuenta|sesenta|setenta|ochenta|noventa|cien|ciento|doscientos|trescientos|cuatrocientos|quinientos|seiscientos|setecientos|ochocientos|novecientos|medio)';

const PATRONES_ENLACE_O_PRECIO: readonly RegExp[] = [
  // Enlaces y contactos, incluidas las formas ofuscadas.
  /https?:\/\//,
  /hxxps?/,
  /\bwww\./,
  /\[\.\]|\(\.\)|\[dot\]/,
  /%[0-9a-f]{2}/,
  /\b[a-z0-9-]+\.[a-z]{2,}\//,
  /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|py|net|org|io|me|app|ar|bo)\b/,
  /@[a-z0-9-]+\./,
  /\bwa\.me\b/,
  // Teléfonos.
  /\d{3,4}[ -]?\d{3}[ -]?\d{3}/,
  // Precios y montos: moneda pegada o no al número, miles, números largos, porcentajes.
  /(?:^|[^a-z])(?:gs|pyg|usd|u\$s|us\$|\$)\.?\s*\d/,
  /₲\s*\d|\d\s*₲/,
  /\d[\d.,\s]*\s*(?:gs\b|pyg\b|usd\b|u\$s|guarani|dolar|lucas)/,
  /\d{1,3}(?:[.,\s]\d{3})+/,
  /\d{5,}/,
  /\d+\s*(?:mil\b|millon|millones)/,
  /\d+\s*%/,
  new RegExp(`\\b${NUMERO_EN_PALABRAS}\\b(?:\\s+[a-z]+){0,3}?\\s+(?:mil|millon|millones|guarani|guaranies|dolar|dolares|lucas)\\b`),
];

/**
 * Detector conservador de enlaces y precios: tolera falsos positivos a propósito (por ejemplo «mil» tras un
 * número en palabras, o un número con separador de miles que no sea un precio). Una cifra corta como «3 pasos»
 * o «10 días» pasa.
 */
export function contieneEnlaceOPrecio(texto: string): boolean {
  const t = paraDetectar(texto);
  return PATRONES_ENLACE_O_PRECIO.some((re) => re.test(t));
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
    if (/\bpoliza\b[^.!?]{0,40}\b(?:emitid[oa]|activad[oa])\b/.test(t)) return 'poliza';
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

export function salidaFallback(config: ConfiguracionEfectiva, etapa: EtapaVenta): SalidaOportunidad {
  return { texto: config.mensajes.errorTemporal, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
}
