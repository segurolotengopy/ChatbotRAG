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
import { SalidaOportunidad, type EstadosOperativos, type EtapaVenta, type Plataforma } from './esquemas.js';
import { formatearGs, formatearTelefono } from './formato-plataforma.js';

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

/**
 * Cada patrón lleva un nombre estable: es lo único que se registra cuando uno dispara (jamás el texto). El orden
 * decide el nombre: un correo en .com o .py dispara `dominio` antes que `correo`, así que `dominio` no significa
 * «no era un correo».
 */
const PATRONES_ENLACE_O_PRECIO: readonly (readonly [string, RegExp])[] = [
  // Enlaces y contactos, incluidas las formas ofuscadas.
  ['https', /https?:\/\//],
  ['hxxp', /hxxps?/],
  ['www', /\bwww\./],
  ['punto_ofuscado', /\[\.\]|\(\.\)|\[dot\]/],
  ['porcentaje_hex', /%[0-9a-f]{2}/],
  ['ruta_dominio', /\b[a-z0-9-]+\.[a-z]{2,}\//],
  ['dominio', /[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|py|net|org|io|me|app|ar|bo)\b/],
  ['correo', /@[a-z0-9-]+\./],
  ['wa_me', /\bwa\.me\b/],
  // Teléfonos.
  ['telefono', /\d{3,4}[ -]?\d{3}[ -]?\d{3}/],
  // Precios y montos: moneda pegada o no al número, miles, números largos, porcentajes.
  ['moneda_antes', /(?:^|[^a-z])(?:gs|pyg|usd|u\$s|us\$|\$)\.?\s*\d/],
  ['simbolo_guarani', /₲\s*\d|\d\s*₲/],
  ['cifra_moneda', /\d[\d.,\s]*\s*(?:gs\b|pyg\b|usd\b|u\$s|guarani|dolar|lucas)/],
  ['miles', /\d{1,3}(?:[.,\s]\d{3})+/],
  ['numero_largo', /\d{5,}/],
  ['mil_millon', /\d+\s*(?:mil\b|millon|millones)/],
  ['porcentaje', /\d+\s*%/],
  // El marcador «§» lo deja `quitarPermitidos` donde había un importe permitido: un multiplicador o una moneda ajena
  // junto a él cambia la cifra («390.000 millones», «US$ 390.000») y no está respaldado.
  ['importe_permitido_alterado', /§\s*(?:mil\b|millon|millones|%|usd\b|u\$s|dolar|lucas)|(?:usd|u\$s|us\$|\$)\.?\s*§/],
  ['numero_en_palabras', new RegExp(`\\b${NUMERO_EN_PALABRAS}\\b(?:\\s+[a-z]+){0,3}?\\s+(?:mil|millon|millones|guarani|guaranies|dolar|dolares|lucas)\\b`)],
];

/**
 * Lo que la plataforma de SLT autoriza a decir (contrato v0.4): importes, teléfonos (E.164) y correos exactos.
 * Todo lo demás sigue bloqueado por los patrones.
 */
export interface Permitidos {
  importes: number[];
  telefonos: string[];
  correos: string[];
}

/** Importes bajo 1000 no disparan ningún patrón y quitarlos solo ensuciaría el texto. */
const IMPORTE_MINIMO_PERMITIDO = 1000;

/**
 * Deriva los permitidos del bloque `plataforma`; sin bloque devuelve `undefined` (nada permitido). Qué NO garantiza:
 * que el modelo use cada dato en el contexto correcto (por ejemplo, un premio como si fuera una indemnización).
 */
export function permitidosDe(plataforma: Plataforma | undefined): Permitidos | undefined {
  if (!plataforma) return undefined;
  const importes = plataforma.planes
    .flatMap((p) => [p.premio_anual_gs, p.capital_fallecimiento_gs, p.indemnizacion_cancer_gs, p.renta_hospitalaria_dia_gs, p.gastos_medicos_accidente_gs])
    .filter((n) => n >= IMPORTE_MINIMO_PERMITIDO);
  const { whatsapp_e164: tel, correo_derechos: correo } = plataforma.contacto;
  return { importes: [...new Set(importes)], telefonos: tel === undefined ? [] : [tel], correos: correo === undefined ? [] : [correo] };
}

const escaparRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Quita del texto (ya normalizado por `paraDetectar`) las apariciones EXACTAS de lo permitido, para que los
 * patrones no las vean. Los límites impiden que un permitido pase como parte de algo mayor: un importe no puede
 * ir pegado a otro dígito ni seguido de «.dd» o «,dd» («390.0001», «1.390.000», «390.000.000» siguen bloqueados);
 * un teléfono no puede ir pegado a un dígito; un correo no puede seguir en un dominio más largo ni venir de una
 * parte local más larga. Cada aparición se sustituye por «§», no por un espacio: así lo que la rodea (un multiplicador, una moneda ajena, otro dígito
 * tras un separador cualquiera) sigue visible y los patrones pueden bloquearlo.
 */
function quitarPermitidos(t: string, p: Permitidos): string {
  let r = t;
  const formas: string[] = [];
  for (const n of p.importes) formas.push(formatearGs(n), String(n));
  for (const f of formas) r = r.replace(new RegExp(`(?<!\\d[^\\p{L}]?)${escaparRe(f)}(?![.,\\s]?\\d)`, 'gu'), '§');
  for (const tel of p.telefonos) {
    for (const f of [tel, formatearTelefono(tel)]) r = r.replace(new RegExp(`${escaparRe(f)}(?!\\d)`, 'g'), '§');
  }
  for (const c of p.correos) {
    r = r.replace(new RegExp(`(?<![a-z0-9._%+-])${escaparRe(c.toLowerCase())}(?![a-z0-9_-]|\\.[a-z0-9])`, 'g'), '§');
  }
  return r;
}

/**
 * Detector conservador de enlaces y precios: tolera falsos positivos a propósito (por ejemplo «mil» tras un
 * número en palabras, o un número con separador de miles que no sea un precio). Una cifra corta como «3 pasos»
 * o «10 días» pasa. Devuelve el nombre del primer patrón que dispara, o null: el nombre permite distinguir
 * un falso positivo de un enlace real en la bitácora sin guardar texto. Con `permitidos`, antes de aplicar los
 * patrones se retiran las apariciones exactas de esos importes, teléfonos y correos; cualquier otra cosa sigue bloqueada.
 */
export function patronEnlaceOPrecio(texto: string, permitidos?: Permitidos): string | null {
  const base = paraDetectar(texto);
  const t = permitidos ? quitarPermitidos(base, permitidos) : base;
  return PATRONES_ENLACE_O_PRECIO.find(([, re]) => re.test(t))?.[0] ?? null;
}

/** Envoltorio booleano de `patronEnlaceOPrecio`; conserva la API anterior. */
export function contieneEnlaceOPrecio(texto: string, permitidos?: Permitidos): boolean {
  return patronEnlaceOPrecio(texto, permitidos) !== null;
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

/**
 * Respuesta cuando el detector bloquea enlaces, teléfonos o importes: antes era el «problema técnico», que no
 * explicaba nada y hacía repetir la pregunta. Frase fija y neutra (sin segunda persona, para valer con voseo, tuteo
 * o usted). Qué NO garantiza: que la persona reciba el dato; solo que no se le diga que hubo una falla.
 */
export const TEXTO_SIN_CIFRAS = 'Los precios, montos, teléfonos y enlaces no los puedo dar por este medio. Una persona del equipo puede ayudar con eso.';

export function salidaSinCifras(etapa: EtapaVenta): SalidaOportunidad {
  return { texto: TEXTO_SIN_CIFRAS, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
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
