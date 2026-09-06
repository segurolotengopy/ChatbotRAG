/**
 * CORTESÍA — mensajes que no son una consulta.
 *
 * Sirve para dos cosas: (1) no exigir respaldo documental a un «gracias», y
 * (2) no contar como atención facturable una despedida (criterio de NovuChat).
 * El riesgo de esta lista es PASARSE, no quedarse corta: un «ok» que en realidad
 * confirma una elección importa, pero eso lo resuelve el modelo con la memoria,
 * no esta función. Por eso el tope de 25 caracteres: una frase larga nunca es
 * solo cortesía.
 */
import { normalizar } from './vocabulario.js';

const FORMULAS = new Set([
  'hola', 'buenas', 'buen dia', 'buenos dias', 'buenas tardes', 'buenas noches', 'que tal', 'hey',
  'gracias', 'muchas gracias', 'mil gracias', 'ok', 'okay', 'oka', 'dale', 'listo', 'perfecto', 'genial',
  'excelente', 'entendido', 'entiendo', 'ya', 'bien', 'muy bien', 'de acuerdo', 'vale', 'bueno',
  'chau', 'chao', 'adios', 'hasta luego', 'nos vemos', 'saludos', 'gracias chau', 'gracias adios',
  'si', 'no', 'claro', 'por favor', 'ayuda', 'hola buenas', 'hola que tal', 'hola buen dia',
]);

export function esCortesia(texto: string): boolean {
  const n = normalizar(texto)
    .replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, '')
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (n.length === 0 || n.length > 25) return false;
  return FORMULAS.has(n);
}

/** Saludo inicial: dispara la bienvenida configurada sin gastar una llamada al modelo. */
export function esSaludo(texto: string): boolean {
  const n = normalizar(texto).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  return n.length <= 25 && /^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|hey|que tal)( .*)?$/.test(n);
}
