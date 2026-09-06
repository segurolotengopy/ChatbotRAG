/**
 * MEMORIA EN PROCESO
 *
 * Suficiente para un servicio de una instancia (Cloud Run con concurrencia) y
 * para las pruebas. Con varias instancias hay que reemplazarla por Firestore,
 * Redis o Postgres detrás del mismo puerto; el orquestador no cambia.
 *
 * TTL por inactividad: una conversación que no recibe mensajes en `ttlSeg` se
 * olvida entera. Es una palanca de costo (windowing + timeout de sesión, criterio
 * C-13 de NovuChat) y una de privacidad (menos retención).
 */
import type { EstadoOrientacion, MemoriaConversacion, TurnoMemoria } from '../puertos/memoria.js';
import type { MensajeTexto } from '../puertos/proveedor-llm.js';

interface Registro {
  turnos: TurnoMemoria[];
  orientacion: EstadoOrientacion;
  venceEn: number;
}

export class MemoriaEnProceso implements MemoriaConversacion {
  readonly nombre = 'en-proceso';
  private readonly registros = new Map<string, Registro>();

  constructor(
    private readonly reloj: () => number = () => Date.now(),
    private readonly maxTurnosGuardados = 60,
  ) {}

  private vigente(id: string): Registro | null {
    const r = this.registros.get(id);
    if (!r) return null;
    if (r.venceEn <= this.reloj()) {
      this.registros.delete(id);
      return null;
    }
    return r;
  }

  async leer(conversacionId: string, ventana: number): Promise<TurnoMemoria[]> {
    const r = this.vigente(conversacionId);
    if (!r) return [];
    return r.turnos.slice(-ventana);
  }

  async agregar(conversacionId: string, turnos: MensajeTexto[], ttlSeg: number): Promise<void> {
    const ahora = this.reloj();
    const r = this.vigente(conversacionId) ?? { turnos: [], orientacion: { facetas: {} }, venceEn: 0 };
    for (const t of turnos) r.turnos.push({ ...t, en: ahora });
    if (r.turnos.length > this.maxTurnosGuardados) r.turnos.splice(0, r.turnos.length - this.maxTurnosGuardados);
    r.venceEn = ahora + ttlSeg * 1000;
    this.registros.set(conversacionId, r);
    this.podar();
  }

  async leerOrientacion(conversacionId: string): Promise<EstadoOrientacion> {
    return this.vigente(conversacionId)?.orientacion ?? { facetas: {} };
  }

  async guardarOrientacion(conversacionId: string, estado: EstadoOrientacion, ttlSeg: number): Promise<void> {
    const ahora = this.reloj();
    const r = this.vigente(conversacionId) ?? { turnos: [], orientacion: { facetas: {} }, venceEn: 0 };
    r.orientacion = { facetas: { ...estado.facetas } };
    r.venceEn = ahora + ttlSeg * 1000;
    this.registros.set(conversacionId, r);
  }

  async olvidar(conversacionId: string): Promise<void> {
    this.registros.delete(conversacionId);
  }

  /** Cantidad de conversaciones vivas (diagnóstico). */
  tamano(): number {
    this.podar();
    return this.registros.size;
  }

  private podar(): void {
    const ahora = this.reloj();
    for (const [id, r] of this.registros) if (r.venceEn <= ahora) this.registros.delete(id);
  }
}
