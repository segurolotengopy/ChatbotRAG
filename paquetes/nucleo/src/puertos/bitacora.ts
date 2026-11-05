/**
 * PUERTO: BITÁCORA
 *
 * NUNCA lleva el texto de los mensajes (ni del usuario ni del asistente). Lleva lo
 * que hace falta para operar y facturar: identificador de conversación con hash,
 * perfil, latencia, tokens, compuertas que actuaron, fragmentos usados. Es la
 * misma regla que en NovuChat (T-25): una bitácora con texto es la puerta trasera
 * a la confidencialidad, además de una copia sin control de retención.
 */
import type { MotivoIa } from '../banco/enrutador.js';
import type { MotivoDerivacion } from '../banco/esquema.js';
import type { CausaErrorProveedor } from './proveedor-llm.js';

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
  | 'corpus_indexado'
  | 'paquete_no_cargado'
  | 'respuesta_no_validada'
  | 'enrutador';

export interface EventoBitacora {
  tipo: TipoEvento;
  agenteId: string;
  perfilId: string | null;
  /** SHA-256 truncado del conversacionId: correlaciona sin identificar. */
  conversacionHash: string;
  canal: string;
  /** Milisegundos, siempre finitos y no negativos (quien arma el evento sustituye lo inválido por 0). */
  latenciaMs?: number;
  tokensEntrada?: number;
  tokensSalida?: number;
  iteraciones?: number;
  /** Nombres de compuertas que actuaron (`niega_ia`, `entrada:cedula`, …). */
  avisos?: string[];
  fragmentos?: string[];
  /** Id de pantalla YA VALIDADO contra la configuración (`mensaje_atendido`, `sin_respaldo`). Jamás el valor crudo del cliente. */
  pagina?: string;
  herramienta?: string;
  codigo?: string;
  /** Evento `error_modelo` (`proveedor` e `indice` de Kuaa): causa enumerada del fallo. Jamás el mensaje del error. */
  causa?: CausaErrorProveedor;
  /** Evento `enrutador` (H4a): carril elegido. Solo enumerados; jamás el texto ni el término que coincidió. */
  carril?: 'fijo' | 'derivacion' | 'ia';
  /** Evento `enrutador`: vía que decidió. */
  via?: 'exacta' | 'semantica';
  /** Evento `enrutador`: puntaje de similitud redondeado a milésimas, solo si hubo propuesta semántica. */
  similitud?: number;
  /** Evento `enrutador`: motivo enumerado de la derivación o de la caída a la IA (no es texto libre). */
  motivo?: MotivoIa | MotivoDerivacion;
  /** Detalle técnico corto, SIN texto del usuario. Tope 200. */
  detalle?: string;
}

export interface Bitacora {
  registrar(evento: EventoBitacora): void;
}
