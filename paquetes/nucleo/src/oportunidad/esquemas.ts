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
 * forma y la regla de que la propuesta del modelo no cambia estados.
 */
import { z } from 'zod';
import { ID_PAGINA } from '../configuracion/esquema.js';

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

/** Listas cerradas del contrato v0.3 de SLT. Cualquier otro valor se rechaza. */
export const Necesidad = z.enum(['respaldo_economico', 'atencion_medica', 'otra_proteccion', 'desconocido']);
export const Producto = z.enum(['VIDA_ONCOLOGICO', 'VIDA', 'ACCIDENTES_PERSONALES', 'RESPONSABILIDAD_CIVIL', 'desconocido']);
export const Plan = z.enum(['CONFIO', 'CONFIO_PLUS', 'CONFIO_TOTAL', 'ninguno']);

/** Ids de objeción O01..O32, escritos de forma literal (no se generan con una regex). */
export const CODIGOS_OBJECION = [
  'O01', 'O02', 'O03', 'O04', 'O05', 'O06', 'O07', 'O08',
  'O09', 'O10', 'O11', 'O12', 'O13', 'O14', 'O15', 'O16',
  'O17', 'O18', 'O19', 'O20', 'O21', 'O22', 'O23', 'O24',
  'O25', 'O26', 'O27', 'O28', 'O29', 'O30', 'O31', 'O32',
] as const;
export const CodigoObjecion = z.enum(CODIGOS_OBJECION);
export type CodigoObjecion = z.infer<typeof CodigoObjecion>;

/** Resumen para recuperar contexto tras un reinicio; solo enumerados, jamás interpolado en el prompt. */
export const ResumenOportunidad = z
  .object({
    necesidad: Necesidad,
    producto: Producto,
    plan: Plan,
    objecion_codigo: z.union([CodigoObjecion, z.literal('ninguna')]),
    objecion_estado: z.union([EstadoObjecion, z.literal('ninguna')]),
  })
  .strict();
export type ResumenOportunidad = z.infer<typeof ResumenOportunidad>;

export const RESUMEN_DESCONOCIDO: ResumenOportunidad = {
  necesidad: 'desconocido',
  producto: 'desconocido',
  plan: 'ninguno',
  objecion_codigo: 'ninguna',
  objecion_estado: 'ninguna',
};

/** Contexto de entrada. `pagina` es el id de pantalla que ya recibe el servicio. Sin datos personales. */
export const ContextoOportunidad = z
  .object({
    oportunidad_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,128}$/)
      .regex(/[A-Za-z]/),
    etapa_actual: EtapaVenta,
    estados: EstadosOperativos,
    permiso_seguimiento: PermisoSeguimiento,
    tarifa_version: z.string().regex(/^[a-z0-9._-]{1,64}$/).nullable(),
    pagina: z.string().regex(ID_PAGINA).nullable(),
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
    texto: z.string().min(1).max(4000),
    etapa_propuesta: EtapaVenta,
    objecion: z.object({ codigo: CodigoObjecion, estado: EstadoObjecion }).strict().nullable(),
    botones: z.array(BotonSalida),
    propuestas: z.array(PropuestaSalida),
  })
  .strict();
export type SalidaOportunidad = z.infer<typeof SalidaOportunidad>;

/**
 * Defensa en profundidad: descarta `continuar_pago` si la solicitud no está completada
 * según los estados (SLT también lo descarta). Valida `estados` (lanza si no son válidos) y
 * devuelve siempre una copia, sin botones repetidos. No muta la salida.
 */
export function filtrarBotonesSalida(salida: SalidaOportunidad, estados: EstadosOperativos): SalidaOportunidad {
  const validos = EstadosOperativos.parse(estados);
  const unicos = [...new Set(salida.botones)];
  const botones = validos.solicitud === 'completada' ? unicos : unicos.filter((b) => b !== 'continuar_pago');
  return { ...salida, botones, propuestas: [...salida.propuestas] };
}

/**
 * En ChatbotRAG ninguna transición operativa existe: los estados vienen de SLT en cada
 * petición. Una etapa propuesta por el modelo es solo una propuesta y jamás es evidencia de
 * pago, póliza o documentos. Valida `estados` (lanza si no son válidos) y devuelve una COPIA
 * sin cambios, sea cual sea la etapa; no hay retroceso ni avance posible desde acá.
 */
export function estadosTrasPropuestaDeEtapa(estados: EstadosOperativos, etapa: unknown): EstadosOperativos {
  void etapa; // la propuesta se ignora a propósito
  return { ...EstadosOperativos.parse(estados) };
}
