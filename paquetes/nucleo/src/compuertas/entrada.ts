/**
 * COMPUERTAS DE ENTRADA
 *
 * Se ejecutan ANTES del modelo y ANTES de la memoria. Si una categoría bloqueada
 * coincide, el texto no viaja a ningún lado: se responde con el mensaje fijo de
 * la configuración y se registra solo la categoría (nunca el texto).
 *
 * Es la regla inviolable #7 de SeguroLoTengo llevada al núcleo: las respuestas
 * de salud, la condición PEP, la cédula y la tarjeta «no salen hacia servicios de
 * IA». No es una decisión por prompt, es una compuerta por código.
 */
import type { CategoriaEntrada } from '../configuracion/esquema.js';
import {
  normalizar,
  pareceNumeroDeDocumento,
  pareceNumeroDeTarjeta,
  pareceOtp,
  PATRON_INYECCION,
  VOCABULARIO_SENSIBLE,
} from './vocabulario.js';

export interface ResultadoEntrada {
  bloqueada: boolean;
  /** Categorías detectadas, estén o no bloqueadas (las no bloqueadas solo se registran). */
  detectadas: CategoriaEntrada[];
  bloqueantes: CategoriaEntrada[];
}

/**
 * Distingue «¿el seguro cubre cáncer?» (pregunta sobre el producto, permitida) de
 * «tengo cáncer» (dato personal de salud, bloqueado). La heurística es
 * conservadora: si el texto habla en primera persona o de un familiar, es dato.
 */
export function esPreguntaGeneral(textoNormalizado: string): boolean {
  const primeraPersona =
    /\b(tengo|tuve|padezco|sufro|me diagnosticaron|me operaron|estoy (enfermo|enferma|embarazada|internado|internada|en tratamiento)|mi (mama|madre|papa|padre|esposo|esposa|hijo|hija|hermano|hermana|pareja) (tiene|tuvo|padece|sufre|esta)|soy (pep|funcionario|funcionaria|diputado|diputada|senador|senadora|ministro|ministra|candidato|candidata|diabetico|diabetica|hipertenso|hipertensa|fumador|fumadora)|\bfumo\b|tomo (medicamentos|pastillas|remedios))/;
  if (primeraPersona.test(textoNormalizado)) return false;
  return (
    /\b(cubre|cobertura|incluye|excluye|exclusion|carencia|que pasa si|en caso de|se considera|aplica|paga|indemniza|que es|significa|requisitos?)\b/.test(textoNormalizado) ||
    textoNormalizado.includes('?')
  );
}

export function detectarCategorias(texto: string): CategoriaEntrada[] {
  const n = normalizar(texto);
  const detectadas: CategoriaEntrada[] = [];
  // Datos por FORMA (lo importante): número de documento, tarjeta, OTP.
  if (pareceNumeroDeDocumento(texto)) detectadas.push('cedula');
  if (pareceNumeroDeTarjeta(texto) || VOCABULARIO_SENSIBLE.tarjeta.test(n)) detectadas.push('tarjeta');
  if (pareceOtp(texto) || VOCABULARIO_SENSIBLE.otp.test(n)) detectadas.push('otp');
  if (VOCABULARIO_SENSIBLE.clave.test(n)) detectadas.push('clave');
  // Datos por VOCABULARIO: salud y PEP. Una pregunta general sobre el producto
  // («¿cubre cáncer?») también coincide; `esPreguntaGeneral` la deja pasar.
  if (VOCABULARIO_SENSIBLE.salud.test(n) && !esPreguntaGeneral(n)) detectadas.push('salud');
  if (VOCABULARIO_SENSIBLE.pep.test(n) && !esPreguntaGeneral(n)) detectadas.push('pep');
  if (PATRON_INYECCION.test(n)) detectadas.push('inyeccion');
  return [...new Set(detectadas)];
}

export function evaluarEntrada(texto: string, bloquear: readonly CategoriaEntrada[]): ResultadoEntrada {
  const detectadas = detectarCategorias(texto);
  const bloqueantes = detectadas.filter((c) => bloquear.includes(c));
  return { bloqueada: bloqueantes.length > 0, detectadas, bloqueantes };
}
