/**
 * REDACCIÓN DE DATOS DE PAGO EN LA SALIDA (P17)
 *
 * Origen: la compuerta de entrada ya impide que el dato de tarjeta o de código llegue
 * al modelo, pero el modelo puede producirlo igual: lo repite desde un resultado de
 * herramienta, lo inventa con aspecto de real o lo devuelve porque la persona lo dio
 * por otro canal. Un número de tarjeta, un CVV o un OTP en la respuesta termina en la
 * pantalla, en la memoria de conversación y en cualquier captura. Acá se BORRA el dato
 * y se conserva el resto de la respuesta: reemplazarla entera perdería la parte útil.
 *
 * Tres detectores sobre el texto ORIGINAL (las posiciones no sirven si se normaliza):
 *  - PAN: 13 a 19 dígitos con a lo sumo un separador (un espacio de cualquier tipo,
 *    incluido NBSP o salto de línea, o un guion) entre dígitos y suma de Luhn válida. Si
 *    el tramo completo no pasa Luhn (porque lo sigue otro número: «… 1111 12/28») se
 *    prueban los subtramos que empiezan y terminan en límite de grupo y se borra el más
 *    largo que pase. Sin Luhn no se toca: así sobreviven teléfonos, montos, pólizas y
 *    fechas.
 *  - CVV: 3 o 4 dígitos INMEDIATAMENTE adyacentes a «cvv», «cvc», «código de seguridad»
 *    o una perífrasis («números de atrás», «del reverso»), antes o después. «Inmediato»
 *    es estricto: entre la palabra y el número solo puede haber espacios, «:» y unas
 *    pocas palabras de enlace («es», «son», «el», «su»…), ≤15 caracteres, sin puntuación
 *    de fin de oración ni otro número. Se descarta el grupo pegado a «/», a «-», «:», «.»
 *    o «,» más un dígito, o precedido por «+», «*» u otro grupo numérico (fechas, horas,
 *    teléfonos, montos). Se borran solo los dígitos.
 *  - OTP: igual criterio de adyacencia, con 4 a 8 dígitos (con separadores) junto a
 *    vocabulario de verificación («otp», «token», «código de verificación», «código de
 *    acceso», «clave temporal», «clave dinámica», «código … por SMS/WhatsApp»).
 *    «código» solo NO basta: «código de reserva 482913» queda intacto.
 *
 * El marcador va entre paréntesis y no entre corchetes porque `extraerMarcas` de
 * `salida.ts` borra todo `[texto]`.
 *
 * Qué NO garantiza: dígitos escritos con palabras («cuatro uno uno uno»), letras
 * intercaladas, homóglifos, palabras clave en caracteres de ancho completo, un PAN
 * partido en dos mensajes, un PAN con «.», «/» o «_» como separador, dígitos de otras
 * escrituras (árabe-índicos) que NFKC no convierte, un CVV con dígitos separados, un OTP
 * sin palabra clave, el vencimiento mes/año, «últimos 4», argumentos de herramientas
 * `http` que el modelo envíe a terceros, ni datos que lleguen en resultados de
 * herramientas del mismo turno. La cercanía es estricta: un CVV u OTP separado de su
 * palabra por otra frase no se detecta, y «número de atrás 1234 de su casa» se borra
 * aunque no sea un CVV (no se distingue sin entender la frase). Un CVV u OTP seguido de
 * otro número separado por espacio («otp 123 456 789») tampoco se borra: no se sabe cuál
 * es el dato. Al PAN se le borra la unión de todos los subtramos que pasan Luhn, así que
 * un número vecino puede borrarse de más.
 */
import { pasaLuhn } from './vocabulario.js';

export const MARCADOR_DATO_ELIMINADO = '(dato eliminado)';

type Rango = [number, number];

/** Tramo máximo de dígitos con a lo sumo un separador entre ellos; se parte luego en grupos. */
const RE_TRAMO = /(?<!\p{Nd})\p{Nd}(?:[\s-]?\p{Nd})*/gu;
const RE_DIGITOS = /\p{Nd}+/gu;

const RE_CVV_CLAVE =
  /(?<!\p{L})(?:cvv|cvc|c[oó]digo\s+de\s+seguridad|n[uú]meros?\s+de\s+atr[aá]s|del\s+reverso)(?!\p{L})/giu;
const RE_OTP_CLAVE =
  /(?<!\p{L})(?:otp|token|c[oó]digo\s+de\s+verificaci[oó]n|c[oó]digo\s+de\s+acceso|clave\s+temporal|clave\s+din[aá]mica|c[oó]digo\s+(?:\S+\s+){0,4}?por\s+(?:sms|whatsapp))(?!\p{L})/giu;

/** Lo único admisible entre la palabra clave y el número (sin puntuación de fin de oración ni dígitos). */
const ENLACE = String.raw`(?:[ \t\u00a0:]|(?<!\p{L})(?:es|son|el|la|las|los|su|de|del|fue|que|sea|n[uú]meros?|atr[aá]s|reverso)(?!\p{L}))*`;
const MAX_ENLACE = 15;

const GRUPO_CVV = String.raw`\p{Nd}{3,4}(?!\p{Nd})`;
const GRUPO_OTP = String.raw`\p{Nd}(?:[ -]?\p{Nd}){3,7}(?!\p{Nd})`;

interface Detector {
  clave: RegExp;
  despues: RegExp; // pegajoso: enlace + grupo, desde el final de la clave
  antes: RegExp; // anclado al final de una ventana corta previa a la clave
}

function detector(clave: RegExp, grupo: string): Detector {
  return {
    clave,
    despues: new RegExp(`(${ENLACE})((?<!\\p{Nd})${grupo})`, 'iuy'),
    antes: new RegExp(`((?<!\\p{Nd})${grupo.replace('(?!\\p{Nd})', '')})(${ENLACE})$`, 'iu'),
  };
}

const DETECTOR_CVV = detector(RE_CVV_CLAVE, GRUPO_CVV);
const DETECTOR_OTP = detector(RE_OTP_CLAVE, GRUPO_OTP);
const VENTANA_ANTES = MAX_ENLACE + 20;

const esDigito = (c: string | undefined): boolean => c !== undefined && /\p{Nd}/u.test(c);

/** Fechas, horas, teléfonos, montos y otros números pegados a un grupo lo descartan como CVV/OTP. */
function esDudoso(texto: string, ini: number, fin: number): boolean {
  const antes = texto[ini - 1];
  const despues = texto[fin];
  if (antes !== undefined && '+*/'.includes(antes)) return true;
  if (despues === '/') return true;
  // Seguido de otro número separado por espacio («otp 123 456 789»): no se sabe cuál es el dato.
  if (despues !== undefined && /\s/u.test(despues)) {
    let q = fin;
    while (q < texto.length && /\s/u.test(texto[q] ?? '')) q++;
    if (esDigito(texto[q])) return true;
  }
  if (antes !== undefined && '-:.,'.includes(antes) && esDigito(texto[ini - 2])) return true;
  if (despues !== undefined && '-:.,'.includes(despues) && esDigito(texto[fin + 1])) return true;
  let p = ini - 1;
  while (p >= 0 && /\s/u.test(texto[p] ?? '')) p--;
  return p >= 0 && esDigito(texto[p]);
}

function rangosPan(texto: string): Rango[] {
  const rangos: Rango[] = [];
  for (const tramo of texto.matchAll(RE_TRAMO)) {
    const base = tramo.index;
    // Grupos de dígitos del tramo con su posición absoluta y sus dígitos ASCII (NFKC).
    // Un grupo cuyos dígitos NFKC no convierte (otra escritura) corta el tramo.
    const grupos: Array<{ ini: number; fin: number; d: string | null }> = [];
    for (const g of tramo[0].matchAll(RE_DIGITOS)) {
      const d = g[0].normalize('NFKC');
      const ascii = /^[0-9]+$/.test(d) ? d : null;
      grupos.push({ ini: base + g.index, fin: base + g.index + g[0].length, d: ascii });
    }
    // TODOS los subtramos contiguos de 13 a 19 dígitos que pasan Luhn; se borra su unión.
    // Un prefijo o sufijo numérico puede formar por azar (1 de cada 10) un subtramo válido
    // que no sea el PAN: si solo se borrara el primero, parte del PAN real quedaría a la
    // vista. Borrar de más es aceptable; dejar parte del PAN visible, no.
    for (let i = 0; i < grupos.length; i++) {
      if (grupos[i]!.d === null) continue;
      let acumulado = '';
      for (let j = i; j < grupos.length; j++) {
        const g = grupos[j]!;
        if (g.d === null) break;
        acumulado += g.d;
        if (acumulado.length > 19) break;
        if (acumulado.length >= 13 && pasaLuhn(acumulado)) rangos.push([grupos[i]!.ini, g.fin]);
      }
    }
  }
  return rangos;
}

/** El número inmediatamente adyacente a cada palabra clave: primero el posterior; si no sirve, el anterior. */
function rangosPorContexto(texto: string, d: Detector): Rango[] {
  const rangos: Rango[] = [];
  for (const k of texto.matchAll(d.clave)) {
    const finClave = k.index + k[0].length;
    d.despues.lastIndex = finClave;
    const m = d.despues.exec(texto);
    if (m && (m[1] ?? '').length <= MAX_ENLACE) {
      const ini = finClave + (m[1] ?? '').length;
      const fin = ini + (m[2] ?? '').length;
      if (!esDudoso(texto, ini, fin)) {
        rangos.push([ini, fin]);
        continue;
      }
    }
    const desde = Math.max(0, k.index - VENTANA_ANTES);
    const ventana = texto.slice(desde, k.index);
    const a = d.antes.exec(ventana);
    if (a && (a[2] ?? '').length <= MAX_ENLACE) {
      const ini = desde + a.index;
      const fin = ini + (a[1] ?? '').length;
      if (!esDigito(texto[ini - 1]) && !esDudoso(texto, ini, fin)) rangos.push([ini, fin]);
    }
  }
  return rangos;
}

export function redactarDatosDePago(texto: string): { texto: string; redactados: number } {
  const todos: Rango[] = [
    ...rangosPan(texto),
    ...rangosPorContexto(texto, DETECTOR_CVV),
    ...rangosPorContexto(texto, DETECTOR_OTP),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);

  const fusionados: Rango[] = [];
  for (const r of todos) {
    const ultimo = fusionados[fusionados.length - 1];
    if (ultimo && r[0] <= ultimo[1]) ultimo[1] = Math.max(ultimo[1], r[1]);
    else fusionados.push([r[0], r[1]]);
  }

  const partes: string[] = [];
  let cursor = 0;
  for (const [ini, fin] of fusionados) {
    partes.push(texto.slice(cursor, ini), MARCADOR_DATO_ELIMINADO);
    cursor = fin;
  }
  partes.push(texto.slice(cursor));
  return { texto: partes.join(''), redactados: fusionados.length };
}
