/**
 * OPORTUNIDAD DE VENTA: ETAPA COMERCIAL Y ESTADOS OPERATIVOS
 *
 * Porqué: la etapa comercial (E01..E12) es lo que el asistente cree que pasa en la
 * conversación; los estados operativos (solicitud, pago, aceptación, póliza,
 * documentos, atención humana) son hechos del mundo. Se separan para que un modelo que
 * «propone» una etapa no pueda dar por pagada una póliza: esos estados solo cambian con
 * un evento firmado (contrato de eventos, fase posterior).
 *
 * Todo es enumerado y estricto: no hay texto libre que determine comportamiento y el
 * contexto NO tiene campos de datos personales (salud, cédula, tarjeta). Lo que se
 * ignora se rechaza (`.strict()`), no se descarta en silencio.
 *
 * Qué NO garantiza: no verifica firmas de eventos ni persiste nada; solo define la
 * forma y la regla de transición.
 */
import { z } from 'zod';

export const ETAPAS_VENTA = [
  'E01',
  'E02',
  'E03',
  'E04',
  'E05',
  'E06',
  'E07',
  'E08',
  'E09',
  'E10',
  'E11',
  'E12',
] as const;
export const EtapaVenta = z.enum(ETAPAS_VENTA);
export type EtapaVenta = z.infer<typeof EtapaVenta>;

/** Nombre canónico de cada etapa (solo documentación y trazas; no decide nada). */
export const NOMBRE_ETAPA: Record<EtapaVenta, string> = {
  E01: 'contacto_iniciado',
  E02: 'necesidad_identificada',
  E03: 'encaje_preliminar',
  E04: 'propuesta_presentada',
  E05: 'decision_acompanada',
  E06: 'solicitud_iniciada',
  E07: 'solicitud_completada',
  E08: 'pago_pendiente',
  E09: 'pago_acreditado',
  E10: 'poliza_emitida',
  E11: 'seguimiento_autorizado',
  E12: 'cierre_sin_venta',
};

export const EstadoSolicitud = z.enum(['desconocido', 'no_iniciada', 'en_curso', 'completada']);
export const EstadoPago = z.enum(['desconocido', 'no_aplica', 'pendiente', 'acreditado', 'rechazado']);
export const EstadoAceptacion = z.enum(['desconocido', 'pendiente', 'aceptada', 'rechazada']);
export const EstadoPoliza = z.enum(['desconocido', 'no_emitida', 'emitida']);
export const EstadoDocumentos = z.enum(['desconocido', 'pendientes', 'recibidos', 'verificados']);
export const EstadoAtencionHumana = z.enum(['desconocido', 'no_requerida', 'solicitada', 'en_curso', 'resuelta']);

export const EstadosOperativos = z
  .object({
    solicitud: EstadoSolicitud,
    pago: EstadoPago,
    aceptacion: EstadoAceptacion,
    poliza: EstadoPoliza,
    documentos: EstadoDocumentos,
    atencion_humana: EstadoAtencionHumana,
  })
  .strict();
export type EstadosOperativos = z.infer<typeof EstadosOperativos>;

export const ESTADOS_OPERATIVOS_DESCONOCIDOS: EstadosOperativos = {
  solicitud: 'desconocido',
  pago: 'desconocido',
  aceptacion: 'desconocido',
  poliza: 'desconocido',
  documentos: 'desconocido',
  atencion_humana: 'desconocido',
};

export const EstadoObjecion = z.enum([
  'detectada',
  'en_aclaracion',
  'respondida',
  'resuelta_explicita',
  'pendiente_humana',
  'cerrada_sin_venta',
]);
export type EstadoObjecion = z.infer<typeof EstadoObjecion>;

export const CanalSeguimiento = z.enum(['ninguno', 'whatsapp', 'correo']);

/** Sin `evidencia_id`: la evidencia del permiso queda en SLT y no viaja a ChatbotRAG. */
export const PermisoSeguimiento = z
  .object({
    vigente: z.boolean(),
    canal: CanalSeguimiento,
  })
  .strict();
export type PermisoSeguimiento = z.infer<typeof PermisoSeguimiento>;

/**
 * Identificador, no texto libre: minúsculas, dígitos y guion bajo, sin espacios ni saltos
 * de línea. PENDIENTE: el contrato v0.2 no enumera necesidad/producto/plan/código de
 * objeción; cuando SLT fije las listas, sustituir por enumerados.
 */
export const Identificador = z.string().regex(/^[a-z0-9_]{1,40}$/);

/** Resumen para recuperar contexto tras un reinicio; solo datos, jamás interpolado en el prompt. */
export const ResumenOportunidad = z
  .object({
    necesidad: Identificador.nullable(),
    producto: Identificador.nullable(),
    plan: Identificador.nullable(),
    objecion_codigo: Identificador.nullable(),
    objecion_estado: EstadoObjecion.nullable(),
  })
  .strict();
export type ResumenOportunidad = z.infer<typeof ResumenOportunidad>;

export const RESUMEN_DESCONOCIDO: ResumenOportunidad = {
  necesidad: null,
  producto: null,
  plan: null,
  objecion_codigo: null,
  objecion_estado: null,
};

/** Contexto de entrada. `pagina` es el id de pantalla que ya recibe el servicio. Sin datos personales. */
export const ContextoOportunidad = z
  .object({
    oportunidad_id: z.string().min(1).max(128),
    etapa_actual: EtapaVenta.nullable(),
    estados: EstadosOperativos,
    permiso_seguimiento: PermisoSeguimiento,
    tarifa_version: z.string().min(1).max(64).nullable(),
    pagina: z.string().min(1).max(128).nullable(),
    resumen: ResumenOportunidad,
  })
  .strict();
export type ContextoOportunidad = z.infer<typeof ContextoOportunidad>;

/** Tipos de evento firmado (contrato F2). Solo el enum: no hay endpoint de eventos en esta fase. */
export const TIPOS_EVENTO_OPORTUNIDAD = [
  'solicitud_iniciada',
  'solicitud_completada',
  'pago_pendiente',
  'pago_acreditado',
  'poliza_emitida',
  'documentos_enviados',
  'atencion_humana_solicitada',
  'baja_comercial',
  'seguimiento_programado',
  'seguimiento_enviado',
] as const;
export const TipoEventoOportunidad = z.enum(TIPOS_EVENTO_OPORTUNIDAD);
export type TipoEventoOportunidad = z.infer<typeof TipoEventoOportunidad>;

export const BotonSalida = z.enum(['ver_planes', 'comparar_planes', 'iniciar_solicitud', 'continuar_pago']);
export const PropuestaSalida = z.enum([
  'seguimiento_solicitado',
  'baja_comercial_solicitada',
  'atencion_humana_solicitada',
]);

/** Esquema de SALIDA del asistente. `etapa_propuesta` es una propuesta, nunca evidencia. */
export const SalidaOportunidad = z
  .object({
    texto: z.string(),
    etapa_propuesta: EtapaVenta,
    objecion: z.object({ codigo: Identificador, estado: EstadoObjecion }).strict().nullable(),
    botones: z.array(BotonSalida),
    propuestas: z.array(PropuestaSalida),
  })
  .strict();
export type SalidaOportunidad = z.infer<typeof SalidaOportunidad>;

/**
 * Defensa en profundidad: descarta `continuar_pago` si la solicitud no está completada
 * según los estados (SLT también lo descarta). Pura: no muta la salida.
 */
export function filtrarBotonesSalida(salida: SalidaOportunidad, estados: EstadosOperativos): SalidaOportunidad {
  if (estados.solicitud === 'completada') return salida;
  return { ...salida, botones: salida.botones.filter((b) => b !== 'continuar_pago') };
}

/** Eventos que sí pueden cambiar un estado operativo: vienen firmados por el sistema. */
export interface EventoOperativoFirmado {
  estado: keyof EstadosOperativos;
  valor: string;
  firmado: true;
}

/** Lo que propone el modelo: una etapa comercial. Nunca es evidencia operativa. */
export interface PropuestaDelModelo {
  etapa_propuesta: EtapaVenta;
}

/**
 * Contrato de transición de un estado operativo. Solo un evento firmado lo cambia; una
 * propuesta del modelo (`etapa_propuesta`) devuelve los estados SIN alteración. En esta
 * fase no hay verificación criptográfica: el contrato exige `firmado: true` en el tipo y
 * en ejecución, y la firma real llega con el contrato de eventos.
 */
export function puedeTransicionarEstadoOperativo(
  actuales: EstadosOperativos,
  evidencia: EventoOperativoFirmado | PropuestaDelModelo | unknown,
): { permitido: boolean; estados: EstadosOperativos } {
  const sinCambio = { permitido: false, estados: { ...actuales } };
  if (typeof evidencia !== 'object' || evidencia === null) return sinCambio;
  const ev = evidencia as Record<string, unknown>;
  if (ev['firmado'] !== true) return sinCambio;
  const estado = ev['estado'];
  if (typeof estado !== 'string' || !Object.prototype.hasOwnProperty.call(actuales, estado)) return sinCambio;
  const clave = estado as keyof EstadosOperativos;
  const enumerado = EstadosOperativos.shape[clave];
  const valor = enumerado.safeParse(ev['valor']);
  if (!valor.success) return sinCambio;
  return { permitido: true, estados: { ...actuales, [clave]: valor.data } };
}
