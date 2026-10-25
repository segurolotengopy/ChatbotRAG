/**
 * VOCABULARIO SENSIBLE Y DETECTORES DE ENTRADA
 *
 * Todo lo que se compara acá se compara sobre texto NORMALIZADO (`normalizar`):
 * NFKD, minúsculas, sin tildes, espacios colapsados. Los patrones se escriben sin
 * acentos por eso. `\b` no funciona detrás de vocal acentuada en JS, y esa es una
 * de las razones para normalizar antes y no después.
 *
 * Se usa NFKD y no NFD porque los dígitos y las letras de ancho completo («４１１１»,
 * «ＴＡＲＪＥＴＡ»), las ligaduras («ﬁ») y los alfabetos matemáticos evadían los
 * detectores: NFD no los lleva a su forma simple. NFKC solo no sirve: recompone «é»
 * y rompería el quitado de tildes. Efecto lateral: «º», «ª», «№» y «½» pasan a letras
 * o dígitos («o», «a», «no», «1⁄2»); no se encontró un falso positivo realista. Los
 * detectores exportados que leen `\d` ASCII sobre texto crudo no pliegan por sí
 * solos: el NFKC lo garantiza `detectarCategorias`. Qué NO garantiza:
 * caracteres invisibles (\p{Cf}, como el espacio de ancho cero), homóglifos de otros
 * alfabetos (la «а» cirílica), dígitos escritos en palabras ni letras intercaladas.
 *
 * Estos detectores son deliberadamente AMPLIOS. Su trabajo no es clasificar con
 * precisión sino impedir que un dato sensible llegue a un modelo de lenguaje o a
 * la memoria de la conversación. Un falso positivo cuesta una frase de cortesía
 * («no necesito ese dato, cuénteme…»); un falso negativo cuesta una fuga.
 */

export function normalizar(texto: string): string {
  return texto
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Vocabulario por categoría. Se aplica sobre texto normalizado. */
export const VOCABULARIO_SENSIBLE: Record<'salud' | 'pep' | 'cedula' | 'tarjeta' | 'otp' | 'clave', RegExp> = {
  salud:
    /\b(enfermedad|enfermo|enferma|diagnostic|cancer|tumor|quimio|diabet|hipertens|cardiac|infarto|vih|sida|hepatitis|epilep|asma|depresion|ansiedad|psiquiatr|embaraz|cirugia|operaci|tratamiento medico|medicamento|receta|antecedente|preexist|discapacidad|internad|hospitaliz|sintoma|dolor|salud mental|adiccion|alcohol|drogas|fumo|fumador|tabaco)\w*/,
  pep: /\b(pep\b|persona expuesta|politicamente expuest|funcionario publico|cargo publico|diputad|senador|ministr|alcalde|gobernador|candidat|partido politico|sancion|lista ofac|lavado)\w*/,
  cedula: /\b(cedula|c\.?i\.?\b|documento de identidad|dni|carnet de identidad|numero de documento|pasaporte)\w*/,
  tarjeta: /\b(tarjeta|numero de tarjeta|cvv|cvc|codigo de seguridad|fecha de vencimiento de la tarjeta|pan\b|visa|mastercard)\w*/,
  otp: /\b(otp|codigo de verificacion|codigo que me llego|codigo de 6 digitos|codigo sms|codigo de whatsapp)\w*/,
  clave: /\b(contrasena|password|clave de acceso|pin\b|mi clave|usuario y clave)\w*/,
};

/**
 * NÚMEROS QUE PARECEN DATOS. Se evalúan sobre el texto original con separadores
 * quitados. Detectan el DATO, no la palabra: «mi documento es 4.523.118» debe
 * bloquearse aunque no diga «cédula».
 */
export function pareceNumeroDeDocumento(texto: string): boolean {
  // Cédula paraguaya (6–7 dígitos) o boliviana (7–8 dígitos), con puntos de miles
  // (4.523.118) o corrida (4523118). Un precio tiene la misma forma: por eso, sin
  // contexto documental, se exige la forma con puntos y que NO haya vocabulario de
  // dinero alrededor. Con contexto documental («mi cédula es…») alcanza el número.
  const conPuntos = texto.match(/(?<![\d.])\d{1,3}(?:\.\d{3}){1,2}(?!\d|\.\d)/g) ?? [];
  const corridos = texto.match(/(?<![\d.])\d{6,8}(?!\d|\.\d)/g) ?? [];
  if (conPuntos.length === 0 && corridos.length === 0) return false;
  const contexto = normalizar(texto);
  const hayContextoDocumento = /\b(cedula|c\.?i\.?\b|documento|dni|carnet|pasaporte)/.test(contexto);
  if (hayContextoDocumento) return true;
  const hayDinero = /\b(gs|bs|usd|\$|precio|premio|prima|cuota|costo|monto|cuesta|cuestan|vale|valen|pagar|pago|anual|mensual|al ano|por ano|guaranies|bolivianos|dolares|importe|total)\b|\$/.test(contexto);
  return conPuntos.length > 0 && !hayDinero;
}

/** Luhn sobre secuencias de 13 a 19 dígitos (con espacios o guiones). */
export function pareceNumeroDeTarjeta(texto: string): boolean {
  const secuencias = texto.match(/(?:\d[ -]?){13,19}/g) ?? [];
  return secuencias.some((s) => {
    const digitos = s.replace(/\D/g, '');
    if (digitos.length < 13 || digitos.length > 19) return false;
    let suma = 0;
    let doble = false;
    for (let i = digitos.length - 1; i >= 0; i--) {
      let d = Number(digitos[i]);
      if (doble) {
        d *= 2;
        if (d > 9) d -= 9;
      }
      suma += d;
      doble = !doble;
    }
    return suma % 10 === 0;
  });
}

/** Un OTP típico: 6 dígitos aislados junto a la palabra código. */
export function pareceOtp(texto: string): boolean {
  const n = normalizar(texto);
  return /\bcodigo\b/.test(n) && /(?<!\d)\d{6}(?!\d)/.test(n);
}

/** Perífrasis del CVV sin nombrarlo: «los 3 números de atrás», «el código del reverso». */
export const PERIFRASIS_CVV = /\b(numeros? de atras|del reverso|de atras)\b/;

/** Luhn sobre una cadena de dígitos ya limpia (copia local: `pareceNumeroDeTarjeta` no se toca). */
export function pasaLuhn(digitos: string): boolean {
  let suma = 0;
  let doble = false;
  for (let i = digitos.length - 1; i >= 0; i--) {
    let d = Number(digitos[i]);
    if (doble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    suma += d;
    doble = !doble;
  }
  return suma % 10 === 0;
}

/**
 * Variante de `pareceNumeroDeTarjeta` para el modo `dato`: acepta también `/` y `_` como
 * separadores («4111/1111/1111/1111»). El modo `palabra` sigue usando la original.
 */
export function pareceNumeroDeTarjetaFlexible(texto: string): boolean {
  const secuencias = texto.normalize('NFKC').match(/(?:\d[ \-/_]{0,3}){13,19}/g) ?? [];
  return secuencias.some((sec) => {
    const digitos = sec.replace(/\D/g, '');
    return digitos.length >= 13 && digitos.length <= 19 && pasaLuhn(digitos);
  });
}

/**
 * DATO DE TARJETA (modo `dato` de la compuerta de entrada). Origen: la batería de
 * SeguroLoTengo del 12 y 19-oct-2026, donde «¿puedo pagar con tarjeta?» se rechazaba
 * por la palabra. Acá se mira el dato, no la palabra. Se llama solo cuando el texto ya
 * trae vocabulario de tarjeta. Detecta: (1) un CVV/CVC o «código de seguridad» con sus
 * dígitos, en ambos sentidos y aunque estén separados; (2) perífrasis del CVV («los 3
 * números de atrás»); (3) un vencimiento mes/año; (4) «últimos 4»/«termina en»; (5) una
 * SECUENCIA contigua de 8 o más dígitos, descartando montos, teléfonos y fechas.
 * Opera sobre texto normalizado (NFKD en normalizar): cubre dígitos de ancho
 * completo; otros disfraces, no.
 * Qué NO garantiza: dígitos escritos con palabras o con letras intercaladas, ni un
 * número en un segundo mensaje, ni un CVV con otra redacción.
 */
export function hayDatoDeTarjeta(texto: string): boolean {
  const n = normalizar(texto);
  // 1. CVV/CVC con dígitos, en ambos sentidos (palabra → dígitos y dígitos → palabra).
  const palabraCvv = '(?:cvv|cvc|codigo de seguridad)';
  const digitosCvv = '\\d(?:[\\s.-]?\\d){2,3}(?!\\d)';
  if (new RegExp(`\\b${palabraCvv}\\b\\D{0,30}(?<!\\d)${digitosCvv}`).test(n)) return true;
  if (new RegExp(`(?<!\\d)${digitosCvv}\\D{0,15}\\b${palabraCvv}\\b`).test(n)) return true;
  // 2. Perífrasis del CVV.
  if (/\b(?:numeros? de atras|del reverso|de atras)\b\D{0,20}(?<!\d)\d{3,4}(?!\d)/.test(n)) return true;
  // 3. Vencimiento mes/año (12/28, 12-2028). Una fecha completa (19-10-2026) no cuenta.
  if (/(?<![\d/-])(?:0?[1-9]|1[0-2])\s*[/-]\s*(?:\d{4}|\d{2})(?!\d)(?![/-]\d)/.test(n)) return true;
  // 4. Últimos cuatro dígitos.
  if (/\b(?:termina|terminada|ultimos?)\b\D{0,15}(?<!\d)\d{4}(?!\d)/.test(n)) return true;
  // 5. Secuencia contigua de 8 o más dígitos (fragmento de PAN, fecha más número).
  for (const m of n.matchAll(/(?<!\d)\d(?:[ .\-/_]{0,3}\d){7,}(?!\d)/g)) {
    const sec = m[0];
    const inicio = m.index ?? 0;
    const digitos = sec.replace(/\D/g, '');
    if (/^\d{1,3}(?:\.\d{3}){2,}$/.test(sec)) continue; // monto con miles
    if (/\b(?:gs|bs|usd|guaranies|dolares|monto|suma|importe)\b|\$/.test(n.slice(Math.max(0, inicio - 12), inicio))) continue; // monto
    if (/^\d{1,2}[ .\-/_]\d{1,2}[ .\-/_](?:\d{2}|\d{4})$/.test(sec) || /^\d{4}[.\-/_]\d{1,2}[.\-/_]\d{1,2}$/.test(sec)) continue; // fecha
    if (/^09\d{2}/.test(digitos)) continue; // celular paraguayo
    return true;
  }
  return false;
}

/**
 * DATO DE CÓDIGO (modo `dato`). Palabra clave (código, otp, token) acompañada, en
 * cualquiera de los dos sentidos y a 40 caracteres o menos (70 si el texto trae
 * vocabulario explícito de OTP: «el código que me llegó por mensaje… es 4829»), de 4 a
 * 8 dígitos, con separadores en grupos («48 29 13», «482-913»). Con vocabulario de OTP
 * acepta además un alfanumérico de 4 a 8 caracteres con al menos 2 dígitos
 * («A7X9K2»). Antes de evaluar quita las frases que son códigos de otra cosa («código
 * postal», «de póliza»…) y, sin vocabulario de OTP, no cuenta un número de 4 dígitos que
 * parezca año. Qué NO garantiza: un código con otra forma, escrito en palabras o en un
 * segundo mensaje, puede pasar.
 */
export function hayDatoDeCodigo(texto: string): boolean {
  const limpio = normalizar(texto).replace(/\bcodigo (?:postal|de poliza|de cliente|de plan|de producto|de area|civil|de barras)\b/g, ' ');
  const hayVocabularioOtp = /verificacion|\botp\b|\bsms\b|whatsapp|que me llego|me llego/.test(limpio);
  const ventana = hayVocabularioOtp ? 70 : 40;
  const claves = [...limpio.matchAll(/\b(?:codigo|otp|token)\b/g)].map((m) => ({ ini: m.index ?? 0, fin: (m.index ?? 0) + m[0].length }));
  if (claves.length === 0) return false;
  const candidatos: Array<{ ini: number; fin: number; digitos: string; soloDigitos: boolean }> = [];
  for (const m of limpio.matchAll(/(?<!\d)\d(?:[\s-]?\d){3,7}(?!\d)/g)) {
    const ini = m.index ?? 0;
    candidatos.push({ ini, fin: ini + m[0].length, digitos: m[0].replace(/\D/g, ''), soloDigitos: true });
  }
  if (hayVocabularioOtp) {
    for (const m of limpio.matchAll(/\b[a-z0-9]{4,8}\b/g)) {
      if (!/[a-z]/.test(m[0]) || (m[0].match(/\d/g) ?? []).length < 2) continue;
      const ini = m.index ?? 0;
      candidatos.push({ ini, fin: ini + m[0].length, digitos: m[0], soloDigitos: false });
    }
  }
  return candidatos.some((c) => {
    if (c.soloDigitos && c.digitos.length === 4 && /^(?:19|20)\d\d$/.test(c.digitos) && !hayVocabularioOtp) return false;
    return claves.some((k) => (k.fin <= c.ini && c.ini - k.fin <= ventana) || (c.fin <= k.ini && k.ini - c.fin <= ventana));
  });
}

/**
 * INYECCIÓN DE INSTRUCCIONES. Frases que intentan redefinir al asistente. No
 * bloquean por sí solas el diálogo (mucha gente escribe «ignora lo anterior» sin
 * mala intención): la compuerta las marca y el orquestador decide según la
 * configuración (`seguridad.bloquearEntrada` incluye `inyeccion` o no).
 */
export const PATRON_INYECCION =
  /\b(ignora|ignore|olvida|olvide) (todas? )?(las |tus |sus )?(instrucciones|reglas|indicaciones) (anteriores|previas|del sistema)|\b(system prompt|prompt del sistema|developer message)|\b(actua|actue|comportate|comportese) como (si fueras|si fuese|un modelo sin|una ia sin)|\bmodo (desarrollador|sin restricciones|dan)\b|\brevela(me)? (tus|sus|las) instrucciones\b|\bmuestra(me)? (tu|el) prompt\b/;
