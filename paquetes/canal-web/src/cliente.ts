/**
 * CLIENTE LIGERO DEL SERVICIO. Sin dependencias; funciona en Node 18+ y en el
 * navegador. Quien lo use decide cómo guarda la clave: en un navegador NO debe
 * exponerse una clave de cliente con cupo alto; lo habitual es que el sitio tenga
 * una ruta propia que reenvíe (como hace segurolotengo-demo) y el widget hable con
 * esa ruta, no con el servicio.
 */
import type { DescripcionAgente, PeticionMensaje, RespuestaError, RespuestaMensaje } from './contrato.js';

export interface OpcionesCliente {
  urlBase: string;
  /** Clave Bearer. Opcional cuando se habla con una ruta intermedia que ya autentica. */
  clave?: string;
  fetch?: typeof fetch;
  tiempoMaximoMs?: number;
}

export class ErrorServicio extends Error {
  constructor(
    public readonly estado: number,
    public readonly motivo: string,
  ) {
    super(`ChatbotRAG ${estado}: ${motivo}`);
    this.name = 'ErrorServicio';
  }
}

export class ClienteChatbotRAG {
  private readonly fetchImpl: typeof fetch;
  private readonly tiempoMaximoMs: number;

  constructor(private readonly opciones: OpcionesCliente) {
    this.fetchImpl = opciones.fetch ?? fetch;
    this.tiempoMaximoMs = opciones.tiempoMaximoMs ?? 20000;
  }

  private async llamar<T>(metodo: string, ruta: string, cuerpo?: unknown): Promise<T> {
    const control = new AbortController();
    const t = setTimeout(() => control.abort(), this.tiempoMaximoMs);
    try {
      const cabeceras: Record<string, string> = { accept: 'application/json' };
      if (cuerpo !== undefined) cabeceras['content-type'] = 'application/json';
      if (this.opciones.clave) cabeceras['authorization'] = `Bearer ${this.opciones.clave}`;
      const r = await this.fetchImpl(`${this.opciones.urlBase.replace(/\/$/, '')}${ruta}`, { method: metodo, headers: cabeceras, signal: control.signal, ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }) });
      if (r.status === 204) return undefined as T;
      const json = (await r.json().catch(() => ({ ok: false, motivo: 'RESPUESTA_INVALIDA' }))) as { ok: boolean; motivo?: string };
      if (!r.ok || !json.ok) throw new ErrorServicio(r.status, (json as RespuestaError).motivo ?? 'ERROR');
      return json as T;
    } finally {
      clearTimeout(t);
    }
  }

  describirAgente(): Promise<DescripcionAgente> {
    return this.llamar<DescripcionAgente>('GET', '/v1/agente');
  }

  enviar(conversacionId: string, peticion: PeticionMensaje): Promise<RespuestaMensaje> {
    return this.llamar<RespuestaMensaje>('POST', `/v1/conversaciones/${encodeURIComponent(conversacionId)}/mensajes`, peticion);
  }

  olvidar(conversacionId: string): Promise<void> {
    return this.llamar<void>('DELETE', `/v1/conversaciones/${encodeURIComponent(conversacionId)}`);
  }
}
