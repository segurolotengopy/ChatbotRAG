/**
 * AFIRMACIONES QUE CONTRADICEN LA BASE (hallazgos de Rodrigo, corrida de 380 preguntas del 8-nov-2026)
 *
 * Defecto que motivó el control: aun con el respaldo correcto en el prompt, el modelo contradijo la base aprobada
 * (dijo que Interseguros es la aseguradora, que la renta no tiene carencia, que las facturas van a nombre del
 * asegurado, que la compañía paga en 30 días, que una exclusión de la renta vale para todas las coberturas) o inventó
 * una regla donde la base calla (solo una póliza por persona, no se suman montos, un familiar puede pagar). El prompt
 * no alcanza: este módulo es el control duro de la salida, en la misma línea que `afirmaHechoNoRespaldado` y
 * `afirmaTratamientoTributario` (funciones puras, expresiones acotadas sobre `paraDetectar`, motivo enumerado).
 *
 * El código PROHÍBE, nunca AFIRMA: ningún detector contiene un dato de la base (ni un plazo, ni una cifra, ni quién es
 * la aseguradora); solo reconoce la FORMA de la afirmación contraria. El texto real de la base sigue en el bucket.
 * Por motivo, la entrada de la base que lo respalda (solo identificadores):
 *   - `rol_corredor`          -> FICHA_VIVE y QA011.
 *   - `carencia_accidente`    -> QA025.
 *   - `exclusion_trasladada`  -> condicionado de la renta, cláusula 4.b, y QA034.
 *   - `titular_facturas`      -> QA068 y C04.
 *   - `plazo_siniestro`       -> QA070.
 *   - `multiples_polizas` y `pago_terceros` -> hueco de la base (no hay regla documentada): se bloquean tanto la
 *     afirmación como la negación, salvo la oración condicional o de consulta.
 * Si la base cambia alguna de estas entradas, este detector debe cambiar con ella.
 *
 * Qué NO garantiza: atrapar toda paráfrasis («la renta corre desde el primer momento», «la que responde es
 * Interseguros»), afirmaciones repartidas en dos oraciones, plazos sin número, ni que la respuesta restante sea
 * completa. Da falsos positivos a propósito (lado seguro): una negación de «90 días» junto a «renta», cualquier «a tu
 * nombre» junto a «comprobante». Es una lista, no una demostración.
 */
import { paraDetectar } from './detector-enlace-precio.js';

export const MOTIVOS_CONTRA_BASE = ['rol_corredor', 'carencia_accidente', 'exclusion_trasladada', 'titular_facturas', 'plazo_siniestro', 'multiples_polizas', 'pago_terceros'] as const;
export type MotivoContraBase = (typeof MOTIVOS_CONTRA_BASE)[number];

/**
 * Corrección que se le agrega al mensaje de la persona cuando se reintenta al modelo, UNA frase fija por motivo. Prohíbe
 * una forma de afirmación y manda ceñirse al respaldo documental; jamás lleva el texto del modelo, un dato de la base ni
 * texto libre (el motivo es enumerado). Está en «usted» como las reglas del prompt.
 */
export const CORRECCION_POR_MOTIVO: Record<MotivoContraBase, string> = {
  rol_corredor:
    'Corrección de su respuesta anterior: no atribuya a Interseguros el papel de aseguradora, ni que el contrato quede a su nombre, ni que decida aceptar o rechazar la solicitud. Diga solo lo que establece el respaldo documental y, si no lo establece, dígalo y derive. Responda de nuevo en el mismo formato.',
  carencia_accidente:
    'Corrección de su respuesta anterior: no afirme que una cobertura carece de período de carencia ni agrupe coberturas distintas bajo una misma carencia. Cite el plazo de cada cobertura tal como figura en el respaldo documental o, si no figura, dígalo y derive. Responda de nuevo en el mismo formato.',
  exclusion_trasladada:
    'Corrección de su respuesta anterior: no extienda a otras coberturas una exclusión que el respaldo documental establece para una sola. Indique a qué cobertura corresponde cada exclusión según el respaldo o, si no figura, dígalo y derive. Responda de nuevo en el mismo formato.',
  titular_facturas:
    'Corrección de su respuesta anterior: no afirme a nombre de quién deben estar las facturas, boletas o comprobantes salvo que el respaldo documental lo establezca de forma expresa; si no, dígalo y derive. Responda de nuevo en el mismo formato.',
  plazo_siniestro:
    'Corrección de su respuesta anterior: no indique un plazo en que la compañía revise, resuelva o pague un reclamo salvo que el respaldo documental lo establezca de forma expresa; no prometa plazos. Responda de nuevo en el mismo formato.',
  multiples_polizas:
    'Corrección de su respuesta anterior: el respaldo documental no establece una regla sobre contratar más de una póliza ni sobre sumar montos; no afirme ni niegue esa posibilidad. Dígalo y derive. Responda de nuevo en el mismo formato.',
  pago_terceros:
    'Corrección de su respuesta anterior: el respaldo documental no establece una regla sobre pagar con medios de otra persona ni sobre que un tercero pague el seguro; no afirme ni niegue esa posibilidad. Dígalo y derive. Responda de nuevo en el mismo formato.',
};

/** Corte de oraciones que no parte tras «Gs.» seguido de cifra ni tras «S.A.». */
export const CORTE_CONTRA_BASE = /(?<!\b[Gg][Ss]\.)(?<!\b[Ss]\.\s?[Aa]\.)(?<=[.!?])\s+|(?<=\b[Gg][Ss]\.)\s+(?![\d\s])/;

export function partirOraciones(texto: string): string[] {
  return texto.split(CORTE_CONTRA_BASE);
}

// ---- rol_corredor ----
const R1 = /\binterseguros(?:\s{1,3}s\.?\s{0,2}a\.?)?\s{0,3},?\s{0,3}(?:que\s{1,3})?(?:es|sera|seria|como|actua\s{1,3}como|funciona\s{1,3}como|opera\s{1,3}como)\s{1,3}(?:la\s{1,3}|una\s{1,3}|tu\s{1,3}|su\s{1,3}|nuestra\s{1,3})?(?:compania\s{1,3})?aseguradora\b/;
const R2 = /\b(?:la\s{1,3})?(?:compania\s{1,3})?aseguradora\s{1,3}(?:es|sera|seria)\s{1,3}interseguros\b/;
const R3 = /\ba\s{1,3}nombre\s{1,3}de\s{1,3}interseguros\b/;
const R3_NEG = /\bno\s{1,3}(?:va|van|esta|estan|estara|queda|sera|figura)\s{1,3}(?:\S+\s{1,3}){0,2}a\s{1,3}nombre\s{1,3}de\s{1,3}interseguros\b/;
const R4 = /\binterseguros(?:\s{1,3}s\.?\s{0,2}a\.?)?\s{1,3}(?:(?:puede|podra|podria|va\s{1,3}a|es\s{1,3}quien|es\s{1,3}la\s{1,3}que|decide\s{1,3}si|se\s{1,3}encarga\s{1,3}de)\s{1,3}(?:aceptar|rechazar|aprobar|emitir)|(?:acepta|rechaza|aprueba|emite)\b)/;

function rolCorredor(t: string): boolean {
  return R1.test(t) || R2.test(t) || (R3.test(t) && !R3_NEG.test(t)) || R4.test(t);
}

// ---- carencia_accidente ----
const NEG_CAR = '(?:sin|no\\s{1,3}(?:hay|tiene|tienen|aplica|aplican|existe|existen|corre|corren|rige|rigen|lleva|llevan|requiere|requieren))(?:\\s{1,3}(?:ninguna|ningun))?\\s{1,3}(?:(?:periodo|plazo)\\s{1,3}de\\s{1,3})?carencias?\\b';
const NEG_CAR_SING = '(?:sin|no\\s{1,3}(?:hay|tiene|aplica|existe|corre|rige|lleva|requiere))(?:\\s{1,3}(?:ninguna|ningun))?\\s{1,3}(?:(?:periodo|plazo)\\s{1,3}de\\s{1,3})?carencias?\\b';
const CAR_NEGADA = new RegExp(`\\b${NEG_CAR}|\\bcarencias?\\s{0,3}:\\s{0,3}(?:no|ninguna|sin)\\b|\\bcarencias?\\s{1,3}(?:de\\s{1,3})?(?:cero|0)\\s{1,3}dias?\\b`);
const FALLEC_LIGADO = new RegExp(
  `\\b${NEG_CAR}\\s{1,3}(?:para|en)\\s{1,3}(?:el\\s{1,3}|la\\s{1,3}cobertura\\s{1,3}de\\s{1,3}|la\\s{1,3}de\\s{1,3})?fallecimiento\\b(?!\\s{0,3}(?:,|y|e|ni|o)\\s{0,3}(?:la\\s{1,3}|el\\s{1,3}|los\\s{1,3})?(?:renta|gastos?|cancer|oncolog|accidente))|\\b(?:el\\s{1,3}|la\\s{1,3}cobertura\\s{1,3}de\\s{1,3})?fallecimiento(?:\\s{1,3}por\\s{1,3}(?:accidente|enfermedad|cualquier\\s{1,3}causa))?\\s{0,3}[,:]?\\s{0,3}(?:es\\s{1,3}|va\\s{1,3})?${NEG_CAR_SING}`,
  'g',
);
const SUJETO_CAR = /\brenta\b|\bgastos?\s{1,3}medicos?\b|\bcancer\b|\boncologic\w*|\b(?:demas|otras|todas\s{1,3}las|resto\s{1,3}de\s{1,3}las)\s{1,3}coberturas\b|\bningun[ao]?\s{1,3}cobertura\b|\baccidentes?\b|\bhospitaliza\w*|\binternacion\b/;

function carenciaAccidente(t: string): boolean {
  const t2 = t.replace(FALLEC_LIGADO, ' ');
  return CAR_NEGADA.test(t2) && SUJETO_CAR.test(t2);
}

// ---- exclusion_trasladada ----
const EXCL_HOSP = /\b(?:no\s{1,3}(?:ameritaron|ameriten|ameritan|amerito|amerite|requirieron|requieran|requieren|requiere|requirio|requiera|necesitaron|necesiten|necesitan|implicaron|impliquen)|sin)\s{1,3}(?:una\s{1,3}|la\s{1,3})?(?:hospitalizacion|internacion)\b/;
const CTX_EXCL = /\bexclu\w*|\bno\s{1,3}(?:cubre|cubren|ampara|amparan|paga|pagan|indemniza|indemnizan)\b|\bquedan?\s{1,3}fuera\b|\bno\s{1,3}estan?\s{1,3}cubiert\w*/;
const RENTA = /\brenta\b/;
const OTRA_COB = /\b(?:gastos?\s{1,3}medicos?|fallecimiento|cancer|oncologic\w*|todas\s{1,3}las\s{1,3}coberturas|cualquier\s{1,3}cobertura|las\s{1,3}demas\s{1,3}coberturas)\b/g;
const NEGADA_ANTES = /\b(?:no|ni|tampoco)\s{1,3}(?:(?:se\s{1,3})?(?:aplica|aplican|traslada|trasladan|extiende|extienden|corresponde|corresponden|rige|rigen)\s{1,3})?(?:a\s{1,3}|en\s{1,3}|para\s{1,3})?(?:los\s{1,3}|las\s{1,3}|la\s{1,3}|el\s{1,3})?(?:cobertura\s{1,3}de\s{1,3})?$/;

function exclusionTrasladada(t: string): boolean {
  if (!(EXCL_HOSP.test(t) && CTX_EXCL.test(t))) return false;
  if (!RENTA.test(t)) return true;
  for (const m of t.matchAll(OTRA_COB)) {
    if (!NEGADA_ANTES.test(t.slice(Math.max(0, m.index - 60), m.index))) return true;
  }
  return false;
}

// ---- titular_facturas ----
const DOC = /\b(?:facturas?|boletas?|comprobantes?|recibos?)\b/;
const A_NOMBRE = /\ba\s{1,3}(?:tu|su|vuestro|mi)\s{1,3}nombre\b|\ba\s{1,3}nombre\s{1,3}(?:tuyo|suyo|propio|del\s{1,3}(?:asegurado|titular|contratante|paciente)|de\s{1,3}(?:la\s{1,3}aseguradora|alianza|interseguros|la\s{1,3}compania|quien\s{1,3}\w+))\b/;
const HEDGE_TIT = /\bno\s{1,3}(?:puedo|podemos|se\s{1,3}puede|te\s{1,3}puedo|le\s{1,3}puedo)\s{1,3}(?:confirmar|asegurar|afirmar|precisar|garantizar)\b|\b(?:requiere|requieren|necesita|falta|pendiente\s{1,3}de)\s{1,3}(?:una\s{1,3})?confirmacion\b|\bpendiente\b|\bno\s{1,3}estan?\s{1,3}(?:confirmad|definid)\w*|\bconsult\w*\s{1,3}(?:a|con)\s{1,3}interseguros\s{1,3}(?:antes|como)\b/;

function titularFacturas(t: string): boolean {
  return DOC.test(t) && A_NOMBRE.test(t) && !HEDGE_TIT.test(t);
}

// ---- plazo_siniestro ----
const CANT_TIEMPO = /\b(?:\d{1,3}|un|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|quince|veinte|treinta|cuarenta|sesenta|noventa)\s{1,3}(?:dias?|semanas?|mes(?:es)?|horas?)\b/;
const RESOL = /\b(?:revis\w*|evalu\w*|analiz\w*|resolv\w*|resuelv\w*|liquid\w*|indemniz\w*|pag(?:a|an|ar|ara|aran|aria|arian|o|os|ue|uen|ado|ados|ada)|abon\w*|respond\w*|reembols\w*|desembols\w*)\b/;
const OBJ = /\b(?:reclamos?|siniestros?|indemnizacion(?:es)?|reembolsos?|compania|aseguradora|alianza)\b/;
const EXENTO = /\b(?:aviso|avisos|avisar|avises|avisa|denunciar|gracia|primas?|premio|vence|vencimiento|retracto|arrepentimiento|carencias?|espera|vigencia|renta|internacion|internad\w*|hospitaliza\w*|cancer|oncologic\w*|diagnostic\w*|minutos?|edad|anos?)\b/;
const HEDGE_PLAZO = /\bno\s{1,3}(?:puedo|podemos|se\s{1,3}puede|te\s{1,3}puedo|le\s{1,3}puedo)\s{1,3}(?:prometer|garantizar|asegurar|confirmar)\b|\bno\s{1,3}hay\s{1,3}(?:un\s{1,3})?plazo\s{1,3}(?:fijo|garantizado|confirmado|prometido)\b/;

function plazoSiniestro(t: string): boolean {
  return CANT_TIEMPO.test(t) && RESOL.test(t) && OBJ.test(t) && !EXENTO.test(t) && !HEDGE_PLAZO.test(t);
}

// ---- multiples_polizas y pago_terceros (el hueco de la base) ----
const HEDGE_PREFIJO = /\b(?:saber|consultar|consulta|consultes|consultalo|preguntar|pregunta|preguntes|confirmar|confirma|averiguar|ver|verificar|revisar|revisen|evaluar|evaluen)\s{1,3}si\s{1,3}(?:no\s{1,3})?$/;
const HEDGE_INFO = /\bno\s{1,3}(?:tengo|cuento\s{1,3}con|hay)\s{1,3}(?:informacion|datos|respaldo)\b|\bno\s{1,3}(?:puedo|podemos)\s{1,3}(?:confirmar|asegurar|afirmar)\b/;

/** Verdadero si alguna coincidencia de `re` (con bandera `g`) NO va precedida de una fórmula de consulta («para saber si…»). */
function coincideSinCondicion(t: string, re: RegExp): boolean {
  for (const m of t.matchAll(re)) {
    if (!HEDGE_PREFIJO.test(t.slice(Math.max(0, m.index - 40), m.index))) return true;
  }
  return false;
}

const MP1 = /\b(?:solo|solamente|unicamente)\s{1,3}(?:podes|puedes|puede|pueden|se\s{1,3}puede|es\s{1,3}posible|se\s{1,3}permite)\s{1,3}(?:contratar|tener|sacar|comprar|adquirir)\s{1,3}(?:una|1)\s{1,3}(?:sola\s{1,3}|unica\s{1,3})?poliza\b/g;
const MP2 = /\b(?:no\s{1,3})?(?:es\s{1,3}posible|podes|puedes|puede|pueden|se\s{1,3}puede|se\s{1,3}permite|esta\s{1,3}permitido)\s{1,3}(?:contratar|tener|sacar|comprar|adquirir)\s{1,3}(?:dos|2|mas\s{1,3}de\s{1,3}una|varias|una\s{1,3}segunda|otra)\s{1,3}polizas?\b/g;
const MP3 = /\buna\s{1,3}(?:sola\s{1,3}|unica\s{1,3})?poliza\s{1,3}(?:(?:de|del)\s{1,3}\S+\s{1,3})?por\s{1,3}(?:persona|titular|asegurado|cedula|cliente)\b/g;
const MP4 = /\b(?:no\s{1,3})?(?:se\s{1,3})?(?:sumarian|suman|sumaran|sumaria|suma|acumularian|acumulan|acumularan|acumula)\s{1,3}(?:los\s{1,3}|las\s{1,3})?(?:montos|capitales|indemnizaciones|coberturas|beneficios|sumas\s{1,3}aseguradas)\b/g;

function multiplesPolizas(t: string): boolean {
  if (HEDGE_INFO.test(t)) return false;
  return [MP1, MP2, MP3, MP4].some((re) => coincideSinCondicion(t, re));
}

const PERSONA_3 =
  '(?:(?:un|una|tu|su|otro|otra|algun|alguna)\\s{1,3}(?:familiar|pariente|pareja|novio|novia|esposo|esposa|conyuge|hijo|hija|madre|padre|mama|papa|hermano|hermana|amigo|amiga|persona|tercero|tercera\\s{1,3}persona)|(?:tus|sus|otros|otras)\\s{1,3}(?:familiares|parientes|padres|hijos|hijas|hermanos|hermanas|amigos|terceros|personas))';
const PT1 = new RegExp(`\\b(?:no\\s{1,3})?(?:podes|puedes|puede|pueden|se\\s{1,3}puede|es\\s{1,3}posible|esta\\s{1,3}permitido)\\s{1,3}pagar\\s{1,3}(?:(?:el|la)\\s{1,3}(?:seguro|poliza|prima|premio|cuota)\\s{1,3})?(?:de|para|por)\\s{1,3}${PERSONA_3}\\b`, 'g');
const PT2 = new RegExp(`\\b(?:tarjeta|cuenta|qr)(?:\\s{1,3}de\\s{1,3}(?:debito|credito))?\\s{1,3}de\\s{1,3}${PERSONA_3}\\b`, 'g');
const PT3 = new RegExp(`\\b${PERSONA_3}\\s{1,3}(?:puede|pueden|podria|podra)\\s{1,3}pagar(?:lo|la|te|le|telo|selo)?\\b`, 'g');

function pagoTerceros(t: string): boolean {
  if (HEDGE_INFO.test(t)) return false;
  return [PT1, PT2, PT3].some((re) => coincideSinCondicion(t, re));
}

const DETECTORES: Record<MotivoContraBase, (t: string) => boolean> = {
  rol_corredor: rolCorredor,
  carencia_accidente: carenciaAccidente,
  exclusion_trasladada: exclusionTrasladada,
  titular_facturas: titularFacturas,
  plazo_siniestro: plazoSiniestro,
  multiples_polizas: multiplesPolizas,
  pago_terceros: pagoTerceros,
};

/** El motivo de la primera regla que marca la oración (en el orden de `MOTIVOS_CONTRA_BASE`), o null. */
export function motivoContraBaseEnOracion(oracion: string): MotivoContraBase | null {
  const t = paraDetectar(oracion);
  for (const motivo of MOTIVOS_CONTRA_BASE) if (DETECTORES[motivo](t)) return motivo;
  return null;
}

/** El motivo de la primera oración del texto que contradice la base, o null. */
export function afirmaContraBase(texto: string): MotivoContraBase | null {
  for (const oracion of partirOraciones(texto)) {
    const m = motivoContraBaseEnOracion(oracion);
    if (m) return m;
  }
  return null;
}

const ANAFORA = /^\s*(?:este|esta|estos|estas|ese|esa|esos|esas|dicho|dicha|dichos|dichas|por\s+lo\s+tanto|por\s+eso|por\s+ende|entonces|asi\s+que|en\s+ese\s+caso|en\s+consecuencia)\b/;

/**
 * Retira las oraciones que contradicen la base y, de la oración siguiente, solo la que se apoya en la retirada con una
 * anáfora («Este plazo empieza a correr…»): quedaría hablando de algo borrado. Un solo nivel: la retirada por anáfora no
 * arrastra a la siguiente. Qué NO garantiza: que lo que queda sea completo; quien llama lo vuelve a revisar.
 */
export function quitarAfirmacionesContraBase(texto: string): { texto: string; motivos: MotivoContraBase[] } {
  const motivos: MotivoContraBase[] = [];
  const partes: string[] = [];
  let anteriorRetiradaPorMotivo = false;
  for (const oracion of partirOraciones(texto)) {
    const motivo = motivoContraBaseEnOracion(oracion);
    if (motivo) {
      if (!motivos.includes(motivo)) motivos.push(motivo);
      anteriorRetiradaPorMotivo = true;
      continue;
    }
    if (anteriorRetiradaPorMotivo && ANAFORA.test(paraDetectar(oracion))) {
      anteriorRetiradaPorMotivo = false;
      continue;
    }
    anteriorRetiradaPorMotivo = false;
    partes.push(oracion);
  }
  return { texto: partes.join(' ').trim(), motivos };
}
