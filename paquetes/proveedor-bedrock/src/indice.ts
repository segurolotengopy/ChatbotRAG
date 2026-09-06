/**
 * ADAPTADOR AMAZON BEDROCK — Converse API + embeddings Titan
 *
 * Único lugar del repositorio que importa `@aws-sdk/client-bedrock-runtime`. La
 * Converse API es agnóstica del modelo (Claude, Nova, Llama…): el mismo código
 * sirve para `anthropic.claude-haiku-4-5…` o `amazon.nova-lite…`; el modelo se
 * elige por configuración (`modelo.nombre`).
 *
 * Traducción del contrato neutral:
 *   sistema            → system: [{ text }]
 *   usuario/asistente  → messages con role user/assistant y content [{ text }]
 *   asistente_herram.  → content [{ toolUse: { toolUseId, name, input } }]
 *   herramienta        → role user, content [{ toolResult: { toolUseId, content:[{ json }] } }]
 *   herramientas       → toolConfig.tools[].toolSpec con inputSchema.json
 *
 * AUTENTICACIÓN: cadena estándar del SDK (rol de la tarea ECS/Lambda, perfil
 * local, variables de entorno). Sin claves en la configuración del agente.
 */
import {
  BedrockRuntimeClient,
  ConverseCommand,
  InvokeModelCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
  type Message,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import type { Embebedor, MensajeLLM, MotivoFin, PeticionLLM, ProveedorLLM, RespuestaLLM } from '@chatbotrag/nucleo';

export interface ClienteBedrock {
  converse(entrada: ConverseCommandInput): Promise<ConverseCommandOutput>;
  invocarJson(modelo: string, cuerpo: Record<string, unknown>): Promise<Record<string, unknown>>;
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

export function crearClienteBedrock(region: string): ClienteBedrock {
  const cliente = new BedrockRuntimeClient({ region });
  return {
    converse: (entrada) => cliente.send(new ConverseCommand(entrada)),
    async invocarJson(modelo, cuerpo) {
      const r = await cliente.send(new InvokeModelCommand({ modelId: modelo, contentType: 'application/json', accept: 'application/json', body: JSON.stringify(cuerpo) }));
      return JSON.parse(new TextDecoder().decode(r.body)) as Record<string, unknown>;
    },
  };
}

export function aMensajes(mensajes: MensajeLLM[]): Message[] {
  const salida: Message[] = [];
  for (const m of mensajes) {
    if (m.rol === 'usuario') salida.push({ role: 'user', content: [{ text: m.contenido }] });
    else if (m.rol === 'asistente') salida.push({ role: 'assistant', content: [{ text: m.contenido }] });
    else if (m.rol === 'asistente_herramientas') {
      salida.push({
        role: 'assistant',
        content: [
          ...(m.texto ? [{ text: m.texto }] : []),
          ...m.llamadas.map((l) => ({ toolUse: { toolUseId: l.id, name: l.nombre, input: l.argumentos as Record<string, never> } })),
        ],
      });
    } else if (m.rol === 'herramienta') {
      const bloque = { toolResult: { toolUseId: m.idLlamada, content: [{ json: (typeof m.resultado === 'object' && m.resultado !== null ? m.resultado : { resultado: m.resultado }) as Record<string, never> }] } };
      const anterior = salida[salida.length - 1];
      if (anterior && anterior.role === 'user' && anterior.content?.every((c) => 'toolResult' in c)) anterior.content.push(bloque);
      else salida.push({ role: 'user', content: [bloque] });
    }
  }
  return salida;
}

function motivo(stop: string | undefined): MotivoFin {
  switch (stop) {
    case 'tool_use':
      return 'herramienta';
    case 'end_turn':
    case 'stop_sequence':
      return 'fin';
    case 'max_tokens':
      return 'max_tokens';
    case 'content_filtered':
    case 'guardrail_intervened':
      return 'seguridad';
    default:
      return stop ? 'otro' : 'fin';
  }
}

export class ProveedorBedrock implements ProveedorLLM {
  readonly nombre = 'bedrock';

  constructor(private readonly cliente: ClienteBedrock) {}

  async generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
    const tools: Tool[] = peticion.herramientas.map((h) => ({
      toolSpec: { name: h.nombre, description: h.descripcion, inputSchema: { json: h.parametros as unknown as Record<string, never> } },
    }));
    let r: ConverseCommandOutput;
    try {
      r = await this.cliente.converse({
        modelId: peticion.parametros.modelo,
        system: [{ text: peticion.sistema }],
        messages: aMensajes(peticion.mensajes),
        inferenceConfig: { temperature: peticion.parametros.temperatura, maxTokens: peticion.parametros.maxTokensSalida },
        ...(tools.length ? { toolConfig: { tools } } : {}),
      });
    } catch (e) {
      throw new ErrorProveedor(`Bedrock (${peticion.parametros.modelo}): ${e instanceof Error ? e.message : String(e)}`, 'bedrock', peticion.parametros.modelo);
    }
    const contenido = r.output?.message?.content ?? [];
    const texto = contenido.map((c) => c.text ?? '').join('').trim();
    const llamadas = contenido
      .filter((c) => c.toolUse)
      .map((c, i) => ({ id: c.toolUse!.toolUseId ?? `bk-${i + 1}`, nombre: c.toolUse!.name ?? '', argumentos: (c.toolUse!.input ?? {}) as Record<string, unknown> }))
      .filter((l) => l.nombre);
    return {
      texto,
      llamadasHerramienta: llamadas,
      motivoFin: motivo(r.stopReason),
      uso: { tokensEntrada: r.usage?.inputTokens ?? 0, tokensSalida: r.usage?.outputTokens ?? 0 },
    };
  }
}

/** Embeddings con Amazon Titan Text Embeddings v2 (1024/512/256 dimensiones). */
export class EmbebedorBedrock implements Embebedor {
  readonly nombre = 'bedrock-titan';
  readonly dimension: number;
  private readonly modelo: string;

  constructor(
    private readonly cliente: ClienteBedrock,
    opciones: { modelo?: string; dimension?: number } = {},
  ) {
    this.modelo = opciones.modelo ?? 'amazon.titan-embed-text-v2:0';
    this.dimension = opciones.dimension ?? 1024;
  }

  async embeber(textos: string[]): Promise<number[][]> {
    const salida: number[][] = [];
    for (const t of textos) {
      let r: Record<string, unknown>;
      try {
        r = await this.cliente.invocarJson(this.modelo, { inputText: t, dimensions: this.dimension, normalize: true });
      } catch (e) {
        throw new ErrorProveedor(`Bedrock embeddings (${this.modelo}): ${e instanceof Error ? e.message : String(e)}`, 'bedrock', this.modelo);
      }
      const v = r['embedding'];
      if (!Array.isArray(v)) throw new ErrorProveedor('Bedrock embeddings: respuesta sin campo embedding', 'bedrock', this.modelo);
      salida.push(v as number[]);
    }
    return salida;
  }
}
