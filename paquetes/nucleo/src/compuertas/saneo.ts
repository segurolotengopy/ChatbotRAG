/**
 * SANEO DE TEXTO — heredado de NovuChat (`saneo.ts`), con la misma disciplina:
 * funciones puras, sin dependencias, probadas sin red.
 *
 * Quita caracteres de control y marcas BIDI (Trojan Source), colapsa espacios y
 * recorta. NO escapa HTML: eso lo hace quien renderiza (React escapa; un canal
 * de WhatsApp no necesita entidades). Escapar acá haría que WhatsApp mostrara
 * `&amp;`.
 */
// eslint-disable-next-line no-control-regex -- la intención es justamente quitar controles
const RE_CONTROLES = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
const RE_BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;

export function sanearTexto(valor: unknown, maxLargo: number): string {
  if (typeof valor !== 'string') return '';
  return valor
    .replace(RE_CONTROLES, '')
    .replace(RE_BIDI, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, maxLargo);
}

/** Identificador seguro para rutas y claves de memoria. */
export const ID_CONVERSACION = /^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/;

export function esIdConversacionValido(valor: unknown): valor is string {
  return typeof valor === 'string' && ID_CONVERSACION.test(valor);
}
