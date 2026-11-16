/**
 * PETICIÓN — contrato mínimo compartido entre el agente genérico y Kuaa
 *
 * Reúne las dependencias del agente, el error de petición y el hash de conversación en
 * un módulo que solo importa `createHash` y tipos. Motivo: `agente-kuaa.ts` necesitaba
 * estos tres símbolos y, al importarlos desde `agente.ts`, arrastraba las herramientas
 * y el armado de prompt del agente genérico; así se puede extraer a Kuaa sin ellos.
 * No cambia comportamiento: `agente.ts` los re-exporta con los mismos nombres.
 */
import { createHash } from 'node:crypto';
import type { ConfiguracionAgente } from '../configuracion/esquema.js';
import type { Bitacora } from '../puertos/bitacora.js';
import type { EjecutorHerramientas } from '../puertos/herramienta.js';
import type { IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import type { MemoriaConversacion } from '../puertos/memoria.js';
import type { ProveedorLLM } from '../puertos/proveedor-llm.js';

export interface DependenciasAgente {
  config: ConfiguracionAgente;
  proveedor: ProveedorLLM;
  indice: IndiceConocimiento | null;
  memoria: MemoriaConversacion;
  herramientas: EjecutorHerramientas;
  bitacora: Bitacora;
  reloj?: () => Date;
}

export class ErrorPeticion extends Error {
  constructor(
    public readonly codigo: 'CONVERSACION_INVALIDA' | 'TEXTO_VACIO' | 'TEXTO_LARGO' | 'PERFIL_DESCONOCIDO',
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorPeticion';
  }
}

export function hashConversacion(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}
