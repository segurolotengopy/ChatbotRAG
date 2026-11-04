/**
 * DETECTOR DE ENLACES Y PRECIOS DE KUAA
 *
 * Porqué: lo que Kuaa dice a la persona no puede traer enlaces, teléfonos ni cifras que la plataforma de SLT no haya
 * autorizado. Este módulo reúne el detector (`patronEnlaceOPrecio`) y lo que lo acompaña: los patrones con nombre
 * estable, los valores permitidos que salen del bloque `plataforma` y su retiro del texto antes de aplicar los
 * patrones. Vive aparte de `salida-kuaa.ts` para que `esquemas.ts` pueda usarlo (la dirección del contacto se valida
 * con el mismo detector) sin un import circular; `salida-kuaa.ts` lo reexporta y la API no cambia.
 *
 * Qué NO garantiza: atrapar toda forma de enlace (el patrón de dominio cubre pocos TLD, y «interseguros360 punto com»
 * pasa); da falsos positivos a propósito; y su costo crece con el cuadrado del largo en entradas repetitivas, acotado
 * por el tope del texto del modelo.
 */
import { normalizarEntradaKuaa } from './normalizar-entrada.js';
import type { Plataforma } from './esquemas.js';
import { formatearGs, formatearTelefono } from './formato-plataforma.js';

/**
 * Texto para detectar: NFKC (ancho completo, U+2024 → «.»), sin caracteres de formato, homóglifos plegados,
 * minúsculas y sin tildes. Solo sirve para comparar; jamás se devuelve a la persona.
 */
export function paraDetectar(texto: string): string {
  return sinTildes(normalizarEntradaKuaa(texto)).toLowerCase();
}

const sinTildes = (t: string): string => t.normalize('NFD').replace(/\p{Mn}/gu, '');

/**
 * El texto tal como se parece al que recibe la persona: NFKC (SIN pasar a minúsculas: las mayúsculas griegas se pliegan
 * distinto a sus minúsculas, y `paraDetectar` pasa a minúsculas DESPUÉS de plegar, como siempre), con los puntos ideográficos («。», «．», «｡»)
 * vueltos «.», sin los invisibles que UTS46 ignora en un nombre de dominio (U+200B, U+00AD, U+2060, U+FEFF, U+034F) y
 * sin los marcadores privados del detector. NO pliega homóglifos ni quita marcas combinantes: eso es justo lo que no
 * debe ocurrir antes de comparar un permitido.
 */
function parecidoEntregado(texto: string): string {
  return texto.normalize('NFKC').replace(/[。．｡]/g, '.').replace(/\u034F|[\u200B\u00AD\u2060\uFEFF\uE000\uE001]/g, '');
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
  // Un enlace de Markdown («](destino)»): el texto visible puede ser un dominio permitido y el destino otro. Acotado a «]»
  // seguido de «(»: un texto con paréntesis suelto («El plan (el básico)…») no dispara, pero «[1] (nota)» sí (falso positivo
  // aceptado: Kuaa no usa listas con corchetes).
  ['markdown_enlace', /\]\s*\(/],
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
  // U+E000 lo deja `quitarPermitidos` cuando el texto repite la dirección permitida con otro número (ver MARCA_ALTERADA).
  ['direccion_alterada', /\uE000/],
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
  /** Dominios (sitio web) que pueden escribirse sueltos, en minúsculas. */
  dominios: string[];
  /** Direcciones que pueden darse como frase completa; se comparan ya normalizadas con `paraDetectar`. */
  direcciones: string[];
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
  const { whatsapp_e164: tel, correo_derechos: correo, sitio_web: sitio, direccion } = plataforma.contacto;
  return {
    importes: [...new Set(importes)],
    telefonos: tel === undefined ? [] : [tel],
    correos: correo === undefined ? [] : [correo],
    dominios: sitio === undefined ? [] : [sitio.toLowerCase()],
    direcciones: direccion === undefined ? [] : [paraDetectar(direccion)],
  };
}

/**
 * Límites de LISTA BLANCA para correos y dominios permitidos (bandera `u`): una lista negra de caracteres vecinos deja
 * pasar letras de otros alfabetos pegadas («øinterseguros360.com»). Antes del permitido: inicio, espacio, signo de
 * apertura, «:» pegado («Correo:derechos@…»), raya larga o media, un guion solo tras un espacio, o un adorno de Markdown
 * (`*`, `_`, comilla invertida) que a su vez vaya tras uno de esos. Después: fin, espacio, signo de cierre, coma o punto
 * y coma, «?», «!», «:» o puntos de frase (incluidos «...» y «…», que NFKC vuelve «...») solo si siguen espacio o fin, o un
 * adorno de Markdown seguido de lo mismo. Qué NO garantiza: que lo que sigue a un espacio sea inocuo; solo que el
 * texto permitido no es parte de una palabra, ruta, consulta o dirección mayor.
 */
const APERTURA = '^|[\\s(«"\'¿¡:—–]|(?:^|\\s)-\\s?';
const LIMITE_ANTES = `(?<=${APERTURA}|(?:^|[\\s(«"'¿¡:—–])[*_\`]{1,3})`;
const CIERRE = '$|[\\s)»"\',;]|[?!](?:\\s|$)|:(?:\\s|$)|\\.+(?:\\s|$)';
const LIMITE_DESPUES = `(?=${CIERRE}|[*_\`]{1,3}(?:${CIERRE}))`;

/**
 * Marcadores de uso privado (el texto del modelo los pierde antes de detectar, así que nadie puede escribirlos): el de
 * la dirección permitida es propio y no «§», que es el de los importes («…Peru mil gracias» no es un importe alterado);
 * pero si la dirección TERMINA en dígito se usa «§»: un «mil», «%» o «millones» pegado cambia esa cifra («Calle Peru 1234 mil»);
 * el de la dirección alterada dispara `direccion_alterada`.
 */
const MARCA_DIRECCION = '\uE001';
const MARCA_ALTERADA = '\uE000';

const escaparRe = (t: string): string => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Retira correos y dominios permitidos sobre un texto que se parece al ENTREGADO a la persona (`parecidoEntregado`: NFKC, sin
 * plegar homóglifos ni tildes ni marcas combinantes): «іnterseguros360.com» (con «і» cirílica),
 * «ínterseguros360.com» o «interse̲guros360.com» no son el dominio permitido aunque, ya plegados, lo parezcan; la persona
 * ve el texto original. Qué NO garantiza: nada sobre lo que rodea al permitido más allá de los límites de lista blanca.
 */
function quitarContactos(t: string, p: Permitidos): string {
  let r = t;
  for (const c of p.correos) {
    r = r.replace(new RegExp(`${LIMITE_ANTES}${escaparRe(c)}${LIMITE_DESPUES}`, 'giu'), '§');
  }
  // Dominio (sitio web): solo el texto suelto, con los mismos límites de lista blanca que el correo. Antes solo puede
  // haber inicio, espacio o un signo de apertura; después, fin, espacio, un signo de cierre o puntuación de frase. Todo lo
  // demás (letras de otros alfabetos pegadas, «&x=1», «](url)», «/ruta», otro rótulo) deja el dominio visible a los patrones.
  for (const d of p.dominios) {
    r = r.replace(new RegExp(`${LIMITE_ANTES}${escaparRe(d)}${LIMITE_DESPUES}`, 'giu'), '§');
  }
  return r;
}

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
  // Dirección: frase completa, sin letra ni número pegados ni «.dd» o «,dd» detrás. Si no está completa pero el texto
  // trae la misma frase con otro número («Av X 1235» por «Av X 1234»), queda el marcador privado U+E000 y el detector la bloquea.
  for (const dir of p.direcciones) {
    const cuerpo = escaparRe(dir);
    r = r.replace(new RegExp(`(?<![\\p{L}\\p{N}])${cuerpo}(?![\\p{L}\\p{N}]|[.,]\\d)`, 'gu'), /\d$/.test(dir) ? '§' : MARCA_DIRECCION);
    if (/\d/.test(dir)) {
      const comodin = cuerpo.replace(/\d+/g, '\\d{1,9}');
      r = r.replace(new RegExp(`(?<![\\p{L}\\p{N}])${comodin}(?![\\p{L}\\p{N}])`, 'gu'), MARCA_ALTERADA);
    }
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
  const entregado = parecidoEntregado(texto);
  // Correos y dominios se comparan contra lo que la persona leerá; solo después se pliegan homóglifos y tildes.
  const sinContactos = permitidos ? quitarContactos(entregado, permitidos) : entregado;
  const t0 = paraDetectar(sinContactos);
  const t = permitidos ? quitarPermitidos(t0, permitidos) : t0;
  return PATRONES_ENLACE_O_PRECIO.find(([, re]) => re.test(t))?.[0] ?? null;
}

/** Envoltorio booleano de `patronEnlaceOPrecio`; conserva la API anterior. */
export function contieneEnlaceOPrecio(texto: string, permitidos?: Permitidos): boolean {
  return patronEnlaceOPrecio(texto, permitidos) !== null;
}
