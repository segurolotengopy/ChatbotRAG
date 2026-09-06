/**
 * PUERTO: MEMORIA DE CONVERSACIÓN
 *
 * La clave de sesión es EXPLÍCITA y la fija quien llama (conversacionId). El
 * defecto más grave posible en un asistente multicliente es compartir memoria
 * entre dos personas; por eso el puerto no admite «la conversación actual»: cada
 * operación recibe la clave.
 *
 * La memoria guarda solo turnos que pasaron las compuertas de entrada: un mensaje
 * bloqueado (cédula, tarjeta, salud) no se recuerda jamás.
 */
import type { MensajeTexto } from './proveedor-llm.js';

export interface TurnoMemoria extends MensajeTexto {
  en: number; // epoch ms
}

export interface EstadoOrientacion {
  /** Respuestas a facetas de orientación ya obtenidas (faceta → opción). */
  facetas: Record<string, string>;
}

export interface MemoriaConversacion {
  readonly nombre: string;
  leer(conversacionId: string, ventana: number): Promise<TurnoMemoria[]>;
  agregar(conversacionId: string, turnos: MensajeTexto[], ttlSeg: number): Promise<void>;
  leerOrientacion(conversacionId: string): Promise<EstadoOrientacion>;
  guardarOrientacion(conversacionId: string, estado: EstadoOrientacion, ttlSeg: number): Promise<void>;
  olvidar(conversacionId: string): Promise<void>;
}
