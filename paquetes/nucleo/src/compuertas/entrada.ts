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
import type { CategoriaEntrada, Seguridad } from '../configuracion/esquema.js';
import {
  hayDatoDeCodigo,
  hayDatoDeTarjeta,
  normalizar,
  pareceNumeroDeDocumento,
  pareceNumeroDeTarjeta,
  pareceNumeroDeTarjetaFlexible,
  PERIFRASIS_CVV,
  pareceOtp,
  PATRON_INYECCION,
  VOCABULARIO_SENSIBLE,
} from './vocabulario.js';
import { esPreguntaDeProductoSinSujeto, PATRON_PEP_ESPACIADO, textoParaVocabularioReforzado } from './sujeto-personal.js';

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
 * Límite conocido: cualquier texto con «?» pasa, así que una declaración escrita como
 * pregunta («me detectaron un tumor, ¿me cubren?») evade esta heurística; el criterio
 * `sin_sujeto` (`sujeto-personal.ts`) lo cierra.
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

/**
 * CONSULTA DE FORMULARIO (`seguridad.criterioSaludPep = declaracion`). «Si marco que sí soy PEP,
 * ¿qué pasa?» pregunta qué hace el sitio con una respuesta; no entrega el dato de una persona. El
 * marco es CERRADO y está anclado al INICIO del mensaje: «si marco/respondo/… (que) (sí|no) soy PEP»
 * o «… que tengo una enfermedad», con «qué pasa» opcional delante. Reglas, todas necesarias:
 *  - el «si» es condicional: sin tilde. «Sí marco que soy PEP» es una afirmación, y `normalizar`
 *    borra la tilde, por eso se mira el texto con tildes (NFKC y minúsculas) antes de normalizar;
 *  - el verbo no es performativo: «declaro» e «indico» están fuera («si declaro que soy PEP» ya es
 *    una declaración);
 *  - el mensaje es una pregunta (lleva «?» o empieza con «¿») y, quitado el marco, queda una pregunta
 *    de procedimiento de lista cerrada, NO VACÍA, sin vocabulario de salud ni de PEP.
 * Cualquier cosa más («lo soy», «porque mi papá es ministro», «tuve cáncer», un segundo marco) la
 * saca del marco y rige el criterio de siempre.
 * Qué NO garantiza: otras formas de preguntar por el formulario siguen bloqueadas (falla hacia lo
 * seguro), no puede saber si quien pregunta ya es PEP, y quien escribe «SI» en mayúsculas sin tilde
 * pasa como condicional si el resto es una pregunta de procedimiento. Tampoco cambia la regla de
 * `esPreguntaGeneral` (ver `criterioSaludPep` en el esquema).
 */
const CABEZA_CONDICIONAL = /^¿?(?:qu[eé] pasa )?si /;
const MARCO_FORMULARIO =
  /^(¿?(?:que pasa )?)si (marco|marcara|tildo|selecciono|respondo|respondiera|contesto|pongo|pusiera) (que )?(si |no )?((soy|fuera|seria) (una? )?(pep|persona expuesta politicamente|persona politicamente expuesta)|(tengo|tuve|padezco) (una |alguna )?(enfermedad|condicion|antecedente)( preexistente| medica| de salud)?)\b/;
const RESTO_PROCEDIMIENTO =
  /^(que pasa|que sucede|que ocurre|que tengo que hacer|que debo hacer|que hago|que me piden|como sigo|puedo seguir|puedo contratar|me rechazan|me pueden rechazar)( despues| luego| entonces)?$/;

export function esConsultaDeFormulario(texto: string): boolean {
  const t = texto.normalize('NFKC');
  const conTildes = t.toLowerCase().replace(/\s+/g, ' ').trim();
  if (!CABEZA_CONDICIONAL.test(conTildes)) return false;
  if (!t.includes('?') && !t.trimStart().startsWith('¿')) return false;
  const n = normalizar(t);
  if (!MARCO_FORMULARIO.test(n)) return false;
  const resto = n
    .replace(MARCO_FORMULARIO, '$1')
    .replace(/[¿?¡!,.;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (VOCABULARIO_SENSIBLE.salud.test(resto) || VOCABULARIO_SENSIBLE.pep.test(resto)) return false;
  return RESTO_PROCEDIMIENTO.test(resto);
}

/**
 * `modo` `palabra` (por omisión): `tarjeta` y `otp` se detectan también por vocabulario.
 * `modo` `dato`: solo por el dato (Luhn, CVV con dígitos, código numérico aislado); el
 * vocabulario por sí solo deja pasar la pregunta de procedimiento. Las demás categorías
 * no cambian en ningún modo.
 */
export function detectarCategorias(
  texto: string,
  modo: Seguridad['vocabularioEntrada'] = 'palabra',
  criterio: Seguridad['criterioSaludPep'] = 'primera_persona',
): CategoriaEntrada[] {
  // Los detectores por forma leen texto crudo con \d ASCII: NFKC antes de llamarlos.
  const t = texto.normalize('NFKC');
  const n = normalizar(t);
  const detectadas: CategoriaEntrada[] = [];
  // Datos por FORMA (lo importante): número de documento, tarjeta, OTP.
  if (pareceNumeroDeDocumento(t)) detectadas.push('cedula');
  if (modo === 'dato') {
    const vocabularioTarjeta = VOCABULARIO_SENSIBLE.tarjeta.test(n) || PERIFRASIS_CVV.test(n);
    if (pareceNumeroDeTarjetaFlexible(t) || (vocabularioTarjeta && hayDatoDeTarjeta(t))) detectadas.push('tarjeta');
    if (pareceOtp(t) || hayDatoDeCodigo(t)) detectadas.push('otp');
  } else {
    if (pareceNumeroDeTarjeta(t) || VOCABULARIO_SENSIBLE.tarjeta.test(n)) detectadas.push('tarjeta');
    if (pareceOtp(t) || VOCABULARIO_SENSIBLE.otp.test(n)) detectadas.push('otp');
  }
  if (VOCABULARIO_SENSIBLE.clave.test(n)) detectadas.push('clave');
  // Datos por VOCABULARIO: salud y PEP. Una pregunta general sobre el producto
  // («¿cubre cáncer?») también coincide; `esPreguntaGeneral` la deja pasar.
  // Con `declaracion` y `sin_sujeto`, solo la consulta de formulario (marco cerrado) queda libre de salud y PEP.
  // Con `sin_sujeto` se añade una segunda vía: el vocabulario sobre texto sin invisibles bloquea salvo que
  // sea una pregunta de producto sin sujeto personal. Solo suma bloqueos.
  const consultaDeFormulario = criterio !== 'primera_persona' && esConsultaDeFormulario(t);
  if (!consultaDeFormulario) {
    const estricto = criterio === 'sin_sujeto';
    const r = estricto ? textoParaVocabularioReforzado(t) : '';
    const libre = estricto && esPreguntaDeProductoSinSujeto(t);
    if ((VOCABULARIO_SENSIBLE.salud.test(n) && !esPreguntaGeneral(n)) || (estricto && VOCABULARIO_SENSIBLE.salud.test(r) && !libre)) detectadas.push('salud');
    if (
      (VOCABULARIO_SENSIBLE.pep.test(n) && !esPreguntaGeneral(n)) ||
      (estricto && (VOCABULARIO_SENSIBLE.pep.test(r) || PATRON_PEP_ESPACIADO.test(r)) && !libre)
    )
      detectadas.push('pep');
  }
  if (PATRON_INYECCION.test(n)) detectadas.push('inyeccion');
  return [...new Set(detectadas)];
}

export function evaluarEntrada(
  texto: string,
  bloquear: readonly CategoriaEntrada[],
  modo: Seguridad['vocabularioEntrada'] = 'palabra',
  criterio: Seguridad['criterioSaludPep'] = 'primera_persona',
): ResultadoEntrada {
  const detectadas = detectarCategorias(texto, modo, criterio);
  const bloqueantes = detectadas.filter((c) => bloquear.includes(c));
  return { bloqueada: bloqueantes.length > 0, detectadas, bloqueantes };
}
