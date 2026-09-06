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

/** Puerto separado: los embeddings pueden venir de otro modelo u otra nube. */
export interface Embebedor {
  readonly nombre: string;
  readonly dimension: number;
  embeber(textos: string[]): Promise<number[][]>;
}
