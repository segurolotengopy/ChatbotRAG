/**
 * FORMATO DE LOS DATOS DE LA PLATAFORMA
 *
 * Una sola fuente para las formas en que un importe o un teléfono aparece en el prompt: el armado del prompt las
 * escribe y el detector de la salida las reconoce como permitidas. Si una cambia, cambia la otra.
 *
 * Qué NO garantizan: validar los datos (lo hace el esquema); la agrupación del teléfono es simple (código de tres
 * dígitos y grupos de tres), no respeta los planes de numeración de cada país.
 */

/** Importe con punto de miles: 390000 → «390.000». */
export function formatearGs(valor: number): string {
  return String(valor).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** E.164 agrupado de forma simple: «+595991478468» → «+595 991 478 468». */
export function formatearTelefono(e164: string): string {
  const digitos = e164.replace(/^\+/, '');
  const grupos = [digitos.slice(0, 3), ...(digitos.slice(3).match(/\d{1,3}/g) ?? [])];
  return `+${grupos.join(' ')}`;
}
