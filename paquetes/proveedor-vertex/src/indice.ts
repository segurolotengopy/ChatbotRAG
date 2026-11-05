/**
 * ADAPTADOR VERTEX AI (Google Cloud) — Gemini + embeddings
 *
 * Único lugar del repositorio que importa `@google/genai`. Traduce el contrato
 * neutral del núcleo (`PeticionLLM` / `RespuestaLLM`) al formato de Gemini:
 *
 *   sistema            → config.systemInstruction
 *   usuario/asistente  → contents con role user/model y parts de texto
 *   asistente_herram.  → parts functionCall (el hilo de llamadas se conserva)
 *   herramienta        → parts functionResponse
 *   herramientas       → tools[0].functionDeclarations (JSON Schema subset)
 *
 * AUTENTICACIÓN: con `vertexai: true` el SDK usa Application Default Credentials
 * (la cuenta de servicio de Cloud Run, o `gcloud auth application-default login`
 * en local). NO hay API key: los secretos no viajan por la configuración. Para
 * pruebas se inyecta un cliente falso mediante `ClienteGemini`.
 *
 * MODELO: se elige por configuración (`modelo.nombre`, p. ej. `gemini-2.5-flash`).
 * Lección de NovuChat: un nombre de modelo retirado devuelve 404 «no longer
 * available»; el error se propaga como `ErrorProveedor` con el nombre incluido
 * para que el diagnóstico sea inmediato.
 *
 * TIEMPO MÁXIMO Y REINTENTO: el 2026-11-03 dos peticiones de Kuaa esperaron 58 s y 20,6 s a Vertex
 * en staging, y el sitio corta a los 20 s. Cada intento de `generar` tiene un tope de 9 000 ms
 * (`tiempoMaximoMs`) y se reintenta una vez (`reintentos`), sin espera entre intentos: peor caso
 * 2 × 9 s = 18 s, bajo el tope del sitio. Solo se reintenta lo transitorio: vencimiento del tiempo,
 * estado 500/502/503/504 y errores de red (ECONNRESET, ETIMEDOUT, EAI_AGAIN, «fetch failed»).
 * El 429 NO se reintenta a propósito: una cuota agotada no se resuelve en 0 ms y reintentar solo
 * duplicaría la presión. Un 400, 401, 403, 404 (modelo retirado), 429 o un error desconocido sale en
 * el primer intento; un `status`/`code` numérico no transitorio decide antes que el texto del mensaje.
 * NO garantiza respuesta: si ambos intentos fallan, se lanza `ErrorProveedor` y el agente responde con
 * su mensaje de respaldo de siempre. El texto propio del error de tiempo no incluye la petición; el
 * de Vertex se propaga tal cual. El tope de 18 s vale POR LLAMADA al modelo, no por turno: el agente
 * genérico puede llamar hasta `maxIteraciones` veces (Kuaa usa una sola). En el peor caso el
 * reintento duplica las llamadas facturables. `crearClienteVertex` NO pasa `httpOptions.retryOptions`
 * a propósito: si se añadiera, el factor sería 2×5. El embebedor no tiene tiempo máximo ni reintento.
 */
import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentResponse, type Part, type Schema, Type } from '@google/genai';
import type { DefinicionHerramientaLLM, Embebedor, MensajeLLM, MotivoFin, PeticionLLM, ProveedorLLM, RespuestaLLM } from '@chatbotrag/nucleo';

export interface OpcionesVertex {
  proyecto: string;
  region: string;
  /** Modelo de embeddings; por defecto `text-embedding-005` (768 dimensiones). */
  modeloEmbeddings?: string;
  dimensionEmbeddings?: number;
}

/** Subconjunto del SDK que usamos; permite inyectar un falso en pruebas. */
export interface ClienteGemini {
  generateContent(peticion: {
    model: string;
    contents: Content[];
    config: { systemInstruction: string; temperature: number; maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number }; tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>; abortSignal?: AbortSignal };
  }): Promise<GenerateContentResponse>;
  embedContent(peticion: { model: string; contents: string[]; config?: { outputDimensionality?: number } }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
}

export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    public readonly proveedor: string,
    public readonly modelo: string,
  ) {
    super(mensaje);
    this.name = 'ErrorProveedor';
  }
}

export function crearClienteVertex(opciones: OpcionesVertex): ClienteGemini {
  const ai = new GoogleGenAI({ vertexai: true, project: opciones.proyecto, location: opciones.region });
  return {
    generateContent: (p) => ai.models.generateContent(p),
    embedContent: (p) => ai.models.embedContent(p),
  };
}

function aEsquema(def: DefinicionHerramientaLLM['parametros']): Schema {
  const properties: Record<string, Schema> = {};
  for (const [k, v] of Object.entries(def.properties)) {
    properties[k] = {
      type: v.type === 'number' ? Type.NUMBER : v.type === 'boolean' ? Type.BOOLEAN : Type.STRING,
      description: v.description,
      ...(v.enum ? { enum: v.enum, format: 'enum' } : {}),
    };
  }
  return { type: Type.OBJECT, properties, ...(def.required?.length ? { required: def.required } : {}) };
}

export function aContenidos(mensajes: MensajeLLM[]): Content[] {
  const contenidos: Content[] = [];
  for (const m of mensajes) {
    if (m.rol === 'usuario') contenidos.push({ role: 'user', parts: [{ text: m.contenido }] });
    else if (m.rol === 'asistente') contenidos.push({ role: 'model', parts: [{ text: m.contenido }] });
    else if (m.rol === 'asistente_herramientas') {
      const parts: Part[] = [];
      if (m.texto) parts.push({ text: m.texto });
      for (const l of m.llamadas) parts.push({ functionCall: { id: l.id, name: l.nombre, args: l.argumentos } });
      contenidos.push({ role: 'model', parts });
    } else if (m.rol === 'herramienta') {
      // functionResponse: Gemini espera un objeto; envolvemos si el resultado no lo es.
      const response = typeof m.resultado === 'object' && m.resultado !== null ? (m.resultado as Record<string, unknown>) : { resultado: m.resultado };
      const anterior = contenidos[contenidos.length - 1];
      const part: Part = { functionResponse: { id: m.idLlamada, name: m.nombre, response } };
      // Varias respuestas de herramientas consecutivas van en el mismo turno de usuario.
      if (anterior && anterior.role === 'user' && anterior.parts?.every((p) => p.functionResponse)) anterior.parts.push(part);
      else contenidos.push({ role: 'user', parts: [part] });
    }
  }
  return contenidos;
}

function motivo(fin: string | undefined, hayLlamadas: boolean): MotivoFin {
  if (hayLlamadas) return 'herramienta';
  switch (fin) {
    case 'STOP':
      return 'fin';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'seguridad';
    default:
      return fin ? 'otro' : 'fin';
  }
}

/** Opciones de la llamada al modelo (no del cliente): tiempo por intento y reintentos tras el primero. */
export interface OpcionesLlamadaVertex {
  tiempoMaximoMs?: number;
  reintentos?: number;
}

class TiempoAgotado extends Error {
  constructor(public readonly ms: number) {
    super(`tiempo máximo de ${ms} ms agotado`);
    this.name = 'TiempoAgotado';
  }
}

const ESTADOS_TRANSITORIOS = new Set([500, 502, 503, 504]);
const RED_TRANSITORIA = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i;

/** Transitorio: vale la pena reintentar. Lo desconocido NO lo es. */
function esTransitorio(e: unknown): boolean {
  if (e instanceof TiempoAgotado) return true;
  if (typeof e === 'object' && e !== null) {
    const { status, code } = e as { status?: unknown; code?: unknown };
    // Un código numérico manda sobre el texto: un 400 cuyo cuerpo cite «ETIMEDOUT» no se reintenta.
    if (typeof status === 'number') return ESTADOS_TRANSITORIOS.has(status);
    if (typeof code === 'number') return ESTADOS_TRANSITORIOS.has(code);
    if (typeof code === 'string' && RED_TRANSITORIA.test(code)) return true;
  }
  return e instanceof Error && RED_TRANSITORIA.test(e.message);
}

export class ProveedorVertex implements ProveedorLLM {
  readonly nombre = 'vertex';
  private readonly tiempoMaximoMs: number;
  private readonly reintentos: number;

  constructor(
    private readonly cliente: ClienteGemini,
    opciones: OpcionesLlamadaVertex = {},
  ) {
    this.tiempoMaximoMs = opciones.tiempoMaximoMs ?? 9000;
    this.reintentos = opciones.reintentos ?? 1;
    if (!Number.isInteger(this.tiempoMaximoMs) || this.tiempoMaximoMs < 1) throw new Error('tiempoMaximoMs debe ser un entero de al menos 1 milisegundo');
    if (!Number.isInteger(this.reintentos) || this.reintentos < 0) throw new Error('reintentos debe ser un entero mayor o igual a 0');
  }

  /** Un intento con su propio AbortController y temporizador; el temporizador se limpia siempre. */
  private async intentar(p: Parameters<ClienteGemini['generateContent']>[0]): Promise<GenerateContentResponse> {
    const control = new AbortController();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const vencimiento = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(() => {
        // Primero el rechazo: si el cliente respeta la señal y rechaza con AbortError, gana el vencimiento.
        rechazar(new TiempoAgotado(this.tiempoMaximoMs));
        control.abort();
      }, this.tiempoMaximoMs);
    });
    try {
      const llamada = this.cliente.generateContent({ ...p, config: { ...p.config, abortSignal: control.signal } });
      // Si gana el temporizador, la llamada abortada puede rechazar después: se silencia para no dejar un rechazo sin atender.
      llamada.catch(() => undefined);
      return await Promise.race([llamada, vencimiento]);
    } finally {
      clearTimeout(temporizador);
    }
  }

  async generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
    const modelo = peticion.parametros.modelo;
    const solicitud: Parameters<ClienteGemini['generateContent']>[0] = {
      model: modelo,
      contents: aContenidos(peticion.mensajes),
      config: {
        systemInstruction: peticion.sistema,
        temperature: peticion.parametros.temperatura,
        maxOutputTokens: peticion.parametros.maxTokensSalida,
        // Con `desactivado`, presupuesto 0: el razonamiento no consume el tope de salida. Con `automatico`
        // no se envía nada y el modelo decide, como siempre. Gemini 2.5 Pro no admite 0 (el servicio lo rechaza).
        ...(peticion.parametros.razonamiento === 'desactivado' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        ...(peticion.herramientas.length
          ? { tools: [{ functionDeclarations: peticion.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: aEsquema(h.parametros) })) }] }
          : {}),
      },
    };
    let r: GenerateContentResponse | undefined;
    for (let intento = 0; ; intento++) {
      try {
        r = await this.intentar(solicitud);
        break;
      } catch (e) {
        if (intento < this.reintentos && esTransitorio(e)) continue;
        throw new ErrorProveedor(`Vertex (${modelo}): ${e instanceof Error ? e.message : String(e)}`, 'vertex', modelo);
      }
    }
    const candidato = r.candidates?.[0];
    const partes = candidato?.content?.parts ?? [];
    const texto = partes.map((p) => p.text ?? '').join('').trim();
    const llamadas = partes
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: p.functionCall!.id ?? `vx-${i + 1}`,
        nombre: p.functionCall!.name ?? '',
        argumentos: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }))
      .filter((l) => l.nombre);
    return {
      texto,
      llamadasHerramienta: llamadas,
      motivoFin: motivo(candidato?.finishReason as string | undefined, llamadas.length > 0),
      uso: { tokensEntrada: r.usageMetadata?.promptTokenCount ?? 0, tokensSalida: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0) },
    };
  }
}

export class EmbebedorVertex implements Embebedor {
  /** `vertex-embeddings:<modelo>`: el modelo forma parte del nombre, y con él la calibración del banco (H4b). */
  readonly nombre: string;
  readonly dimension: number;
  private readonly modelo: string;

  constructor(
    private readonly cliente: ClienteGemini,
    opciones: { modelo?: string; dimension?: number } = {},
  ) {
    this.modelo = opciones.modelo ?? 'text-embedding-005';
    this.nombre = `vertex-embeddings:${this.modelo}`;
    this.dimension = opciones.dimension ?? 768;
  }

  async embeber(textos: string[]): Promise<number[][]> {
    if (textos.length === 0) return [];
    const salida: number[][] = [];
    for (const lote of agruparPorPresupuesto(textos)) {
      let r: { embeddings?: Array<{ values?: number[] }> };
      try {
        r = await this.cliente.embedContent({ model: this.modelo, contents: lote, config: { outputDimensionality: this.dimension } });
      } catch (e) {
        throw new ErrorProveedor(`Vertex embeddings (${this.modelo}): ${e instanceof Error ? e.message : String(e)}`, 'vertex', this.modelo);
      }
      const vectores = r.embeddings ?? [];
      if (vectores.length !== lote.length) throw new ErrorProveedor(`Vertex embeddings devolvió ${vectores.length} vectores para ${lote.length} textos`, 'vertex', this.modelo);
      for (const v of vectores) salida.push(v.values ?? []);
    }
    return salida;
  }
}

/** Textos por petición: el servicio admite hasta 250; se queda corto a propósito. */
export const MAX_TEXTOS_POR_LOTE = 100;
/**
 * Caracteres por petición. El modelo rechaza una petición de más de 20 000 tokens en total (no por texto):
 * el 2026-10-31 un lote de 100 fragmentos de ~900 caracteres midió 31 145 y la carga del paquete de Kuaa
 * falló. Con 20 000 caracteres, incluso a 1,5 caracteres por token (peor caso, texto con números y
 * símbolos) quedan ~13 300 tokens, bajo el tope. No garantiza el tope para un texto suelto más largo que
 * el presupuesto: ese viaja solo y el servicio decide.
 */
export const MAX_CARACTERES_POR_LOTE = 20_000;

export function agruparPorPresupuesto(textos: string[]): string[][] {
  const lotes: string[][] = [];
  let actual: string[] = [];
  let caracteres = 0;
  for (const t of textos) {
    if (actual.length > 0 && (actual.length >= MAX_TEXTOS_POR_LOTE || caracteres + t.length > MAX_CARACTERES_POR_LOTE)) {
      lotes.push(actual);
      actual = [];
      caracteres = 0;
    }
    actual.push(t);
    caracteres += t.length;
  }
  if (actual.length > 0) lotes.push(actual);
  return lotes;
}
