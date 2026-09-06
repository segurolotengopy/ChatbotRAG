/**
 * CAMPOS DERIVADOS — se calculan, no se almacenan.
 *
 * Heredado de NovuChat (`prompt.ts`): guardar `horarioLegible` junto a `horarios`
 * invita a que se separen, y entonces el asistente anuncia un horario distinto del
 * que muestra la pantalla. Un solo dato, una sola verdad.
 *
 * `datosQueNoTenemos` es el campo que existe por un incidente real: ante «¿dónde
 * queda su clínica?» el agente INVENTÓ una dirección. La lista se COMPUTA desde los
 * campos vacíos y se le suman los declarados a mano. Los computados no se pueden
 * quitar desde la configuración: la ausencia de un dato es un hecho verificable;
 * pedir que alguien la declare es pedirle que se acuerde de lo que no hizo.
 */
import { DIAS, type ConfiguracionEfectiva } from './esquema.js';

const NOMBRE_DIA: Record<(typeof DIAS)[number], string> = {
  lun: 'lunes',
  mar: 'martes',
  mie: 'miércoles',
  jue: 'jueves',
  vie: 'viernes',
  sab: 'sábado',
  dom: 'domingo',
};

/** «lunes: 09:00-18:00; martes: …». Vacío si no hay horarios. */
export function horarioLegible(horarios: Record<string, string | undefined>): string {
  const partes: string[] = [];
  for (const d of DIAS) {
    const v = horarios[d];
    if (!v) continue;
    partes.push(`${NOMBRE_DIA[d]}: ${v.toLowerCase() === 'cerrado' ? 'cerrado' : v}`);
  }
  return partes.join('; ');
}

const ETIQUETA_FALTANTE: Array<{ falta: (c: ConfiguracionEfectiva) => boolean; etiqueta: string }> = [
  { falta: (c) => !c.datos.direccion, etiqueta: 'la dirección física' },
  { falta: (c) => Object.keys(c.operacion.horarios).length === 0, etiqueta: 'los horarios de atención' },
  {
    falta: (c) => !c.operacion.contactoHumano.whatsapp && !c.operacion.contactoHumano.correo && !c.operacion.contactoHumano.telefono,
    etiqueta: 'un teléfono o correo de contacto',
  },
];

export function datosQueNoTenemos(config: ConfiguracionEfectiva): string[] {
  const faltantes = ETIQUETA_FALTANTE.filter((e) => e.falta(config)).map((e) => e.etiqueta);
  for (const declarado of config.datos.datosQueNoTenemos.slice(0, 20)) {
    const limpio = declarado.trim().slice(0, 80);
    if (limpio && !faltantes.includes(limpio)) faltantes.push(limpio);
  }
  return faltantes;
}

/** Fecha y hora legibles en la zona del agente, para inyectar al prompt. */
export function fechaHoraLegible(ahora: Date, zonaHoraria: string, idioma: string): string {
  try {
    return new Intl.DateTimeFormat(idioma.startsWith('es') ? 'es' : idioma, {
      timeZone: zonaHoraria,
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(ahora);
  } catch {
    return ahora.toISOString();
  }
}

export function estaOperativo(config: ConfiguracionEfectiva): boolean {
  return config.operacion.estado === 'operativo';
}
