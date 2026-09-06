/**
 * PUERTO: BITÁCORA
 *
 * NUNCA lleva el texto de los mensajes (ni del usuario ni del asistente). Lleva lo
 * que hace falta para operar y facturar: identificador de conversación con hash,
 * perfil, latencia, tokens, compuertas que actuaron, fragmentos usados. Es la
 * misma regla que en NovuChat (T-25): una bitácora con texto es la puerta trasera
 * a la confidencialidad, además de una copia sin control de retención.
 */
export type TipoEvento =
  | 'mensaje_atendido'
  | 'entrada_bloqueada'
  | 'sin_respaldo'
  | 'compuerta_salida'
  | 'derivacion'
  | 'herramienta'
  | 'error_modelo'
  | 'suspendido'
  | 'configuracion_cargada'
  | 'corpus_indexado';

export interface EventoBitacora {
  tipo: TipoEvento;
  agenteId: string;
  perfilId: string | null;
  /** SHA-256 truncado del conversacionId: correlaciona sin identificar. */
  conversacionHash: string;
  canal: string;
  latenciaMs?: number;
  tokensEntrada?: number;
  tokensSalida?: number;
  iteraciones?: number;
  /** Nombres de compuertas que actuaron (`niega_ia`, `entrada:cedula`, …). */
  avisos?: string[];
  fragmentos?: string[];
  herramienta?: string;
  codigo?: string;
  /** Detalle técnico corto, SIN texto del usuario. Tope 200. */
  detalle?: string;
}

export interface Bitacora {
  registrar(evento: EventoBitacora): void;
}
