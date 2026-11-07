/**
 * PUERTO: PROVEEDOR DE MODELO DE LENGUAJE
 *
 * Es la frontera hacia la nube. El núcleo arma un `PeticionLLM` neutral y el
 * adaptador (Vertex, Bedrock, simulado) lo traduce a su API. Cambiar de nube es
 * cambiar de adaptador; ninguna otra pieza del núcleo conoce a Google ni a Amazon.
 *
 * El contrato es deliberadamente pequeño: texto del sistema, mensajes alternados,
 * declaraciones de herramientas y parámetros. Todo lo que no cabe acá (streaming,
 * imágenes, cache de prompt) se agrega cuando haga falta y con los dos
 * adaptadores a la vez, para que ninguno quede atrás.
 */
export type RolMensaje = 'usuario' | 'asistente';

export interface MensajeTexto {
  rol: RolMensaje;
  contenido: string;
}

/** Resultado de una herramienta que el núcleo devuelve al modelo. */
export interface MensajeResultadoHerramienta {
  rol: 'herramienta';
  idLlamada: string;
  nombre: string;
  /** JSON serializable. El adaptador lo convierte a la forma que su API exige. */
  resultado: unknown;
}

/** Turno del asistente que incluyó llamadas a herramientas (se reenvía para mantener el hilo). */
export interface MensajeLlamadasHerramienta {
  rol: 'asistente_herramientas';
  texto: string;
  llamadas: LlamadaHerramienta[];
}

export type MensajeLLM = MensajeTexto | MensajeResultadoHerramienta | MensajeLlamadasHerramienta;

export interface DefinicionHerramientaLLM {
  nombre: string;
  descripcion: string;
  /** JSON Schema (subconjunto: object con properties string/number/boolean, enum, required). */
  parametros: {
    type: 'object';
    properties: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; enum?: string[] }>;
    required?: string[];
  };
}

export interface ParametrosLLM {
  modelo: string;
  temperatura: number;
  maxTokensSalida: number;
  /** `desactivado` pide no razonar antes de responder; el adaptador lo respeta si su modelo lo permite. */
  razonamiento?: 'automatico' | 'desactivado';
}

export interface PeticionLLM {
  sistema: string;
  mensajes: MensajeLLM[];
  herramientas: DefinicionHerramientaLLM[];
  parametros: ParametrosLLM;
}

export interface LlamadaHerramienta {
  id: string;
  nombre: string;
  argumentos: Record<string, unknown>;
}

export type MotivoFin = 'fin' | 'herramienta' | 'max_tokens' | 'seguridad' | 'otro';

export interface RespuestaLLM {
  texto: string;
  llamadasHerramienta: LlamadaHerramienta[];
  motivoFin: MotivoFin;
  uso: { tokensEntrada: number; tokensSalida: number };
}

export interface ProveedorLLM {
  readonly nombre: string;
  generar(peticion: PeticionLLM): Promise<RespuestaLLM>;
}

/**
 * Causa enumerada de un fallo del proveedor. La clasifica el adaptador (que conoce los códigos de su nube);
 * el núcleo solo recibe el valor. Existe para que la bitácora diga POR QUÉ falló sin guardar el mensaje del
 * error (que puede citar la petición) y para que el agente elija un texto distinto ante la demanda alta.
 * `cuota` = límite de la nube (429); `saturacion` = límite de concurrencia propio o 503 de la nube;
 * `tiempo` = vencimiento (o 504); `autenticacion` = 401/403; `modelo` = 404 (modelo retirado); `servidor` = otros 5xx
 * (500, 502); `otro` = lo demás. Qué NO garantiza: que la
 * clasificación sea exacta (un adaptador nuevo puede no informar causa y entonces vale `otro`).
 */
export const CAUSAS_ERROR_PROVEEDOR = ['cuota', 'tiempo', 'autenticacion', 'modelo', 'saturacion', 'servidor', 'otro'] as const;
export type CausaErrorProveedor = (typeof CAUSAS_ERROR_PROVEEDOR)[number];

/** Lee `causa` de un error desconocido; devuelve `otro` si no hay una causa válida (nunca lanza, nunca lee el mensaje). */
export function causaDeError(e: unknown): CausaErrorProveedor {
  if (typeof e !== 'object' || e === null) return 'otro';
  const causa = (e as { causa?: unknown }).causa;
  return typeof causa === 'string' && (CAUSAS_ERROR_PROVEEDOR as readonly string[]).includes(causa) ? (causa as CausaErrorProveedor) : 'otro';
}

/** Puerto separado: los embeddings pueden venir de otro modelo u otra nube. */
export interface Embebedor {
  readonly nombre: string;
  readonly dimension: number;
  embeber(textos: string[]): Promise<number[][]>;
  /**
   * Opcional: embeber para INDEXAR (corpus y paquete, lotes grandes, fuera del tráfico), con topes más holgados que los de la
   * consulta de un turno. Si no existe, el índice usa `embeber`. El núcleo no sabe de topes: solo elige la vía.
   */
  embeberParaIndexar?(textos: string[]): Promise<number[][]>;
}
