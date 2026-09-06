/**
 * PUERTO: EJECUTOR DE HERRAMIENTAS
 *
 * Las herramientas `interna` las resuelve el núcleo. Las `http` las resuelve el
 * servicio (que sí puede hablar con la red) mediante este puerto. El núcleo pasa
 * el contexto mínimo: configuración efectiva, conversación (hash) y argumentos.
 */
import type { ConfiguracionEfectiva } from '../configuracion/esquema.js';

export interface ContextoHerramienta {
  config: ConfiguracionEfectiva;
  conversacionId: string;
  canal: string;
  ahora: Date;
}

export interface ResultadoHerramienta {
  /** JSON serializable que vuelve al modelo. */
  resultado: unknown;
  /** Si la herramienta decidió derivar a una persona, el orquestador lo propaga. */
  derivacion?: { motivo: string };
  /** Recomendación determinista (orientación) para adjuntar a la respuesta. */
  recomendacion?: { id: string; texto: string };
}

export interface EjecutorHerramientas {
  ejecutar(nombre: string, argumentos: Record<string, unknown>, contexto: ContextoHerramienta): Promise<ResultadoHerramienta>;
}
