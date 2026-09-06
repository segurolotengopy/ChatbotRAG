/**
 * CONTRATO HTTP DEL SERVICIO — tipos compartidos por cualquier cliente (widget,
 * app móvil, puente de WhatsApp, adaptador del demo). Si el servicio cambia una
 * respuesta, cambia acá y los clientes dejan de compilar: ése es el punto.
 */
export interface RespaldoDocumental {
  fuenteId: string;
  titulo: string;
  version: string;
  puntaje: number;
}

export interface RespuestaMensaje {
  ok: true;
  conversacionId: string;
  perfilId: string | null;
  texto: string;
  respaldo: RespaldoDocumental[];
  avisos: string[];
  derivacion: { motivo: string } | null;
  recomendacion: { id: string; texto: string } | null;
  uso: { iteraciones: number; tokensEntrada: number; tokensSalida: number; latenciaMs: number };
}

export interface RespuestaError {
  ok: false;
  motivo: string;
}

export interface PerfilPublico {
  id: string;
  nombre: string;
  descripcion: string | null;
  bienvenida: string;
}

export interface DescripcionAgente {
  ok: true;
  agente: { id: string; nombreAsistente: string; organizacion: string; idioma: string };
  perfilPorDefecto: string | null;
  perfiles: PerfilPublico[];
  bienvenida: string;
  maxCaracteresEntrada: number;
}

export interface PeticionMensaje {
  perfilId?: string | null;
  texto: string;
  canal?: string;
}

/** Genera un id de conversación válido para el servicio (`^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$`). */
export function nuevoIdConversacion(prefijo = 'web'): string {
  const aleatorio = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID().replace(/-/g, '') : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefijo}_${aleatorio}`.slice(0, 120);
}
