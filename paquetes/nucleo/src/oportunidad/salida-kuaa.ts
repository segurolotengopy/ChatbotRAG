/**
 * INTERPRETACIÓN Y CONTROL DE LA SALIDA DE KUAA
 *
 * El puerto del proveedor no permite pedir JSON con esquema, así que el modelo responde un objeto
 * JSON dentro del texto. Acá se acepta SOLO un único objeto (opcionalmente en un bloque de código
 * marcado json) que cumpla `SalidaOportunidad`; cualquier otra cosa es inválida y el agente cae al
 * mensaje de error temporal. Nunca se entrega texto del modelo sin validar.
 *
 * `contieneEnlaceOPrecio` es un detector conservador (prefiere descartar a dejar pasar). Qué NO
 * garantiza: atrapar todas las formas de escribir un precio o un enlace («ciento cincuenta mil»,
 * dominios sin barra). Puede dar falsos positivos con números con separador de miles.
 */
import type { ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { SalidaOportunidad, type EtapaVenta } from './esquemas.js';

const RE_BLOQUE = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/i;

export function interpretarSalidaModelo(texto: string): SalidaOportunidad | null {
  let cuerpo = texto.trim();
  const bloque = RE_BLOQUE.exec(cuerpo);
  if (bloque?.[1] !== undefined) cuerpo = bloque[1].trim();
  if (!cuerpo.startsWith('{') || !cuerpo.endsWith('}')) return null;
  let valor: unknown;
  try {
    valor = JSON.parse(cuerpo);
  } catch {
    return null;
  }
  const r = SalidaOportunidad.safeParse(valor);
  return r.success ? r.data : null;
}

const PATRONES_ENLACE_O_PRECIO: readonly RegExp[] = [
  /https?:\/\//i,
  /\bwww\./i,
  /\b[a-z0-9-]+\.[a-z]{2,}\/\S*/i,
  /(?:\bGs\b\.?|₲|\bPYG\b|\bUSD\b|\bUS\$|\$)\s*\d/i,
  /\d[\d.,]*\s*(?:gs\b|₲|pyg\b|usd\b|guaran[ií]es|d[oó]lares)/i,
  /\d{1,3}(?:\.\d{3})+/,
  /\b\d+\s*mil\b/i,
];

export function contieneEnlaceOPrecio(texto: string): boolean {
  return PATRONES_ENLACE_O_PRECIO.some((re) => re.test(texto));
}

export function salidaFallback(config: ConfiguracionEfectiva, etapa: EtapaVenta): SalidaOportunidad {
  return { texto: config.mensajes.errorTemporal, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
}
