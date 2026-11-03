/**
 * PLANTILLAS DEL BANCO DE RESPUESTAS
 *
 * Por qué existe: las respuestas aprobadas llevan variables `{{variable}}` de una lista cerrada que el sistema
 * rellena con datos de la plataforma. Este módulo las reconoce y las rellena en una sola pasada.
 *
 * Defecto que motiva el control: una plantilla que sale con `{{premio_plan}}` sin rellenar, o con un valor que
 * a su vez contiene llaves, mostraría al cliente texto roto o permitiría reinterpretar datos como plantilla.
 * Regla dura: nunca sale texto con llaves. Si falta un valor se informa y quien llama decide (derivar);
 * si, pese a todo, quedan llaves, se lanza un error.
 *
 * Qué NO garantiza: que el valor resuelto sea correcto ni que el texto aprobado tenga sentido para el cliente.
 */
import type { VariablePlantilla } from './esquema.js';
import { VARIABLES_PLANTILLA } from './esquema.js';

export type ResolverVariables = (v: VariablePlantilla) => string | null;

// Acotada: nombre solo en minúsculas y guion bajo; sin cuantificadores anidados.
const PATRON_VARIABLE = /\{\{\s*([a-z_]+)\s*\}\}/g;
const CONOCIDAS: ReadonlySet<string> = new Set(VARIABLES_PLANTILLA);

const esConocida = (nombre: string): nombre is VariablePlantilla => CONOCIDAS.has(nombre);

export function variablesDe(plantilla: string): { conocidas: VariablePlantilla[]; desconocidas: string[]; malformada: boolean } {
  const conocidas: VariablePlantilla[] = [];
  const desconocidas: string[] = [];
  for (const m of plantilla.matchAll(PATRON_VARIABLE)) {
    const nombre = m[1] ?? '';
    if (esConocida(nombre)) {
      if (!conocidas.includes(nombre)) conocidas.push(nombre);
    } else if (!desconocidas.includes(nombre)) {
      desconocidas.push(nombre);
    }
  }
  const resto = plantilla.replace(PATRON_VARIABLE, '');
  return { conocidas, desconocidas, malformada: /[{}]/.test(resto) };
}

export function rellenarPlantilla(
  plantilla: string,
  resolver: ResolverVariables,
): { ok: true; texto: string } | { ok: false; faltantes: VariablePlantilla[] } {
  const faltantes: VariablePlantilla[] = [];
  const texto = plantilla.replace(PATRON_VARIABLE, (_coincidencia, nombre: string) => {
    if (!esConocida(nombre)) throw new Error('plantilla sin rellenar');
    const valor = resolver(nombre);
    if (valor === null || valor === '') {
      if (!faltantes.includes(nombre)) faltantes.push(nombre);
      return '';
    }
    return valor;
  });
  if (faltantes.length > 0) return { ok: false, faltantes };
  if (/[{}]/.test(texto)) throw new Error('plantilla sin rellenar');
  return { ok: true, texto };
}
