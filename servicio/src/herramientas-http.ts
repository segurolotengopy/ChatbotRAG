/**
 * EJECUTOR DE HERRAMIENTAS `http`
 *
 * El núcleo no habla con la red; el servicio sí. Cada herramienta `http` declara
 * una `url` https; acá se hace `POST` con JSON `{ herramienta, argumentos,
 * contexto }` y cabeceras de firma HMAC-SHA256 sobre `timestamp.cuerpo`, el mismo
 * esquema que NovuChat usa hacia Firebase. El destinatario verifica la firma con el
 * secreto compartido y rechaza ventanas mayores a 5 minutos.
 *
 * Tiempo máximo de 8 s: una herramienta lenta no puede colgar la conversación.
 * El contexto que viaja es mínimo y NO incluye el texto del usuario ni el
 * identificador de conversación en claro (solo su hash).
 */
import { createHash, createHmac } from 'node:crypto';
import type { ContextoHerramienta, EjecutorHerramientas, ResultadoHerramienta } from '@chatbotrag/nucleo';

export interface OpcionesEjecutorHttp {
  secretoHmac: string | null;
  tiempoMaximoMs?: number;
  fetch?: typeof fetch;
}

export class EjecutorHerramientasHttp implements EjecutorHerramientas {
  private readonly tiempoMaximoMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opciones: OpcionesEjecutorHttp) {
    this.tiempoMaximoMs = opciones.tiempoMaximoMs ?? 8000;
    this.fetchImpl = opciones.fetch ?? fetch;
  }

  async ejecutar(nombre: string, argumentos: Record<string, unknown>, contexto: ContextoHerramienta): Promise<ResultadoHerramienta> {
    const declarada = contexto.config.herramientas.find((h) => h.nombre === nombre);
    if (!declarada || declarada.tipo !== 'http' || !declarada.url) throw new Error(`Herramienta http no declarada: ${nombre}`);

    const cuerpo = JSON.stringify({
      herramienta: nombre,
      argumentos,
      contexto: {
        agenteId: contexto.config.id,
        perfilId: contexto.config.perfilId,
        conversacionHash: createHash('sha256').update(contexto.conversacionId).digest('hex').slice(0, 16),
        canal: contexto.canal,
        zonaHoraria: contexto.config.identidad.zonaHoraria,
        ahora: contexto.ahora.toISOString(),
      },
    });
    const cabeceras: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'chatbotrag/0.1' };
    if (this.opciones.secretoHmac) {
      const ts = String(Math.floor(Date.now() / 1000));
      cabeceras['x-chatbotrag-timestamp'] = ts;
      cabeceras['x-chatbotrag-firma'] = createHmac('sha256', this.opciones.secretoHmac).update(`${ts}.${cuerpo}`).digest('hex');
    }

    const control = new AbortController();
    const temporizador = setTimeout(() => control.abort(), this.tiempoMaximoMs);
    try {
      const r = await this.fetchImpl(declarada.url, { method: 'POST', headers: cabeceras, body: cuerpo, signal: control.signal });
      if (!r.ok) throw new Error(`la herramienta respondió ${r.status}`);
      const json = (await r.json()) as { resultado?: unknown; derivacion?: { motivo: string } };
      return { resultado: json.resultado ?? json, ...(json.derivacion ? { derivacion: json.derivacion } : {}) };
    } finally {
      clearTimeout(temporizador);
    }
  }
}
