/**
 * VOCABULARIO SENSIBLE Y DETECTORES DE ENTRADA
 *
 * Todo lo que se compara acá se compara sobre texto NORMALIZADO (`normalizar`):
 * minúsculas, sin tildes, espacios colapsados. Los patrones se escriben sin
 * acentos por eso. `\b` no funciona detrás de vocal acentuada en JS, y esa es una
 * de las razones para normalizar antes y no después.
 *
 * Estos detectores son deliberadamente AMPLIOS. Su trabajo no es clasificar con
 * precisión sino impedir que un dato sensible llegue a un modelo de lenguaje o a
 * la memoria de la conversación. Un falso positivo cuesta una frase de cortesía
 * («no necesito ese dato, cuénteme…»); un falso negativo cuesta una fuga.
 */

export function normalizar(texto: string): string {
  return texto
    .normalize('NFD')
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

/**
 * INYECCIÓN DE INSTRUCCIONES. Frases que intentan redefinir al asistente. No
 * bloquean por sí solas el diálogo (mucha gente escribe «ignora lo anterior» sin
 * mala intención): la compuerta las marca y el orquestador decide según la
 * configuración (`seguridad.bloquearEntrada` incluye `inyeccion` o no).
 */
export const PATRON_INYECCION =
  /\b(ignora|ignore|olvida|olvide) (todas? )?(las |tus |sus )?(instrucciones|reglas|indicaciones) (anteriores|previas|del sistema)|\b(system prompt|prompt del sistema|developer message)|\b(actua|actue|comportate|comportese) como (si fueras|si fuese|un modelo sin|una ia sin)|\bmodo (desarrollador|sin restricciones|dan)\b|\brevela(me)? (tus|sus|las) instrucciones\b|\bmuestra(me)? (tu|el) prompt\b/;
