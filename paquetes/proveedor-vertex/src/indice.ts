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
    config: { systemInstruction: string; temperature: number; maxOutputTokens: number; tools?: Array<{ functionDeclarations: FunctionDeclaration[] }> };
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

export class ProveedorVertex implements ProveedorLLM {
  readonly nombre = 'vertex';

  constructor(private readonly cliente: ClienteGemini) {}

  async generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
    let r: GenerateContentResponse;
    try {
      r = await this.cliente.generateContent({
        model: peticion.parametros.modelo,
        contents: aContenidos(peticion.mensajes),
        config: {
          systemInstruction: peticion.sistema,
          temperature: peticion.parametros.temperatura,
          maxOutputTokens: peticion.parametros.maxTokensSalida,
          ...(peticion.herramientas.length
            ? { tools: [{ functionDeclarations: peticion.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: aEsquema(h.parametros) })) }] }
            : {}),
        },
      });
    } catch (e) {
      throw new ErrorProveedor(`Vertex (${peticion.parametros.modelo}): ${e instanceof Error ? e.message : String(e)}`, 'vertex', peticion.parametros.modelo);
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
      uso: { tokensEntrada: r.usageMetadata?.promptTokenCount ?? 0, tokensSalida: r.usageMetadata?.candidatesTokenCount ?? 0 },
    };
  }
}

export class EmbebedorVertex implements Embebedor {
  readonly nombre = 'vertex-embeddings';
  readonly dimension: number;
  private readonly modelo: string;

  constructor(
    private readonly cliente: ClienteGemini,
    opciones: { modelo?: string; dimension?: number } = {},
  ) {
    this.modelo = opciones.modelo ?? 'text-embedding-005';
    this.dimension = opciones.dimension ?? 768;
  }

  async embeber(textos: string[]): Promise<number[][]> {
    if (textos.length === 0) return [];
    const salida: number[][] = [];
    // El límite por petición es de 250 textos; se procesa en lotes conservadores.
    for (let i = 0; i < textos.length; i += 100) {
      const lote = textos.slice(i, i + 100);
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
