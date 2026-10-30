/**
 * FRASES FIJAS DEL AGENTE KUAA
 *
 * Igual que `prompt/frases.ts`: el valor de un enumerado (etapa, estado, resumen) SELECCIONA una
 * frase de estas tablas; jamás se interpola. `oportunidad_id`, `tarifa_version`, `pagina` y el código
 * de objeción no entran al prompt. Las frases tratan al MODELO de usted; el trato a la persona lo
 * decide `voz.tratamiento`. No llevan precios, enlaces ni texto comercial: eso, si existe, llega solo
 * como RESPALDO documental habilitado.
 *
 * Qué NO garantizan: son instrucciones al modelo. El control duro es el esquema de salida, el
 * detector de enlaces y precios y las compuertas de salida; y los estados los fija SLT, no el modelo.
 */
import {
  CODIGOS_OBJECION,
  type EstadosOperativos,
  type EtapaVenta,
  BotonSalida,
  EstadoObjecion,
  ETAPAS_VENTA,
  PropuestaSalida,
  type ResumenOportunidad,
} from './esquemas.js';

export const FRASE_ETAPA_KUAA: Record<EtapaVenta, string> = {
  E01: 'Etapa comercial actual: contacto iniciado. Salude y entienda para qué viene la persona.',
  E02: 'Etapa comercial actual: identificando la necesidad. Pregunte, de a una cosa por mensaje, qué quiere proteger.',
  E03: 'Etapa comercial actual: encaje preliminar. Oriente en general sin decidir por la persona.',
  E04: 'Etapa comercial actual: propuesta presentada. Explique solo lo que figure en el respaldo habilitado.',
  E05: 'Etapa comercial actual: acompañando la decisión. Aclare dudas sin presionar.',
  E06: 'Etapa comercial actual: solicitud iniciada. Acompañe el paso a paso sin pedir datos sensibles.',
  E07: 'Etapa comercial actual: solicitud completada. No pida repetir lo ya hecho.',
  E08: 'Etapa comercial actual: pago pendiente. No afirme que el pago se acreditó.',
  E09: 'Etapa comercial actual: pago acreditado según el sistema. No prometa la emisión de la póliza.',
  E10: 'Etapa comercial actual: póliza emitida según el sistema. Atienda dudas posteriores.',
  E11: 'Etapa comercial actual: seguimiento autorizado. Respete el permiso indicado.',
  E12: 'Etapa comercial actual: cierre sin venta. Despídase con cordialidad y no insista.',
};

export const FRASE_ESTADO_SOLICITUD: Record<EstadosOperativos['solicitud'], string> = {
  desconocido: 'Estado de la solicitud: no se conoce. No afirme nada sobre ella.',
  no_iniciada: 'Estado de la solicitud: no iniciada.',
  en_curso: 'Estado de la solicitud: en curso.',
  completada: 'Estado de la solicitud: completada.',
};
export const FRASE_ESTADO_PAGO: Record<EstadosOperativos['pago'], string> = {
  desconocido: 'Estado del pago: no se conoce. No afirme nada sobre él.',
  no_aplica: 'Estado del pago: todavía no corresponde.',
  pendiente: 'Estado del pago: pendiente.',
  acreditado: 'Estado del pago: acreditado según el sistema.',
  rechazado: 'Estado del pago: rechazado. No insista ni dé detalles que no figuren en el respaldo.',
};
export const FRASE_ESTADO_ACEPTACION: Record<EstadosOperativos['aceptacion'], string> = {
  desconocido: 'Estado de la aceptación: no se conoce. No afirme nada sobre ella.',
  pendiente: 'Estado de la aceptación: pendiente. No diga que fue aceptada.',
  aceptada: 'Estado de la aceptación: aceptada según el sistema.',
  rechazada: 'Estado de la aceptación: rechazada. Ofrezca el contacto humano.',
};
export const FRASE_ESTADO_POLIZA: Record<EstadosOperativos['poliza'], string> = {
  desconocido: 'Estado de la póliza: no se conoce. No afirme nada sobre ella.',
  no_emitida: 'Estado de la póliza: no emitida. No la dé por emitida.',
  emitida: 'Estado de la póliza: emitida según el sistema.',
};
export const FRASE_ESTADO_DOCUMENTOS: Record<EstadosOperativos['documentos'], string> = {
  desconocido: 'Estado de los documentos: no se conoce. No afirme nada sobre ellos.',
  pendientes: 'Estado de los documentos: pendientes.',
  recibidos: 'Estado de los documentos: recibidos, sin verificar.',
  verificados: 'Estado de los documentos: verificados según el sistema.',
};
export const FRASE_ESTADO_ATENCION_HUMANA: Record<EstadosOperativos['atencion_humana'], string> = {
  desconocido: 'Atención humana: no se conoce su estado.',
  no_requerida: 'Atención humana: no requerida por ahora.',
  solicitada: 'Atención humana: ya solicitada. No la prometa de nuevo.',
  en_curso: 'Atención humana: en curso.',
  resuelta: 'Atención humana: resuelta.',
};

export type ClavePermiso = 'vigente_whatsapp' | 'vigente_correo' | 'no_vigente';
export const FRASE_PERMISO_SEGUIMIENTO: Record<ClavePermiso, string> = {
  vigente_whatsapp: 'Permiso de seguimiento: vigente por WhatsApp. Solo puede proponerlo; no lo ejecuta.',
  vigente_correo: 'Permiso de seguimiento: vigente por correo. Solo puede proponerlo; no lo ejecuta.',
  no_vigente: 'Permiso de seguimiento: no vigente. No ofrezca ni prometa seguimiento.',
};

export const FRASE_NECESIDAD: Record<ResumenOportunidad['necesidad'], string> = {
  desconocido: 'Necesidad declarada: aún no se conoce.',
  respaldo_economico: 'Necesidad declarada: respaldo económico.',
  atencion_medica: 'Necesidad declarada: atención médica.',
  otra_proteccion: 'Necesidad declarada: otra protección.',
};
export const FRASE_PRODUCTO: Record<ResumenOportunidad['producto'], string> = {
  desconocido: 'Producto de interés: aún no se conoce.',
  VIDA_ONCOLOGICO: 'Producto de interés: vida con cobertura oncológica.',
  VIDA: 'Producto de interés: vida.',
  ACCIDENTES_PERSONALES: 'Producto de interés: accidentes personales.',
  RESPONSABILIDAD_CIVIL: 'Producto de interés: responsabilidad civil.',
};
export const FRASE_PLAN: Record<ResumenOportunidad['plan'], string> = {
  ninguno: 'Plan de interés: ninguno elegido.',
  CONFIO: 'Plan de interés: el plan básico de la familia de planes.',
  CONFIO_PLUS: 'Plan de interés: el plan intermedio de la familia de planes.',
  CONFIO_TOTAL: 'Plan de interés: el plan más completo de la familia de planes.',
};
export const FRASE_OBJECION_ESTADO: Record<ResumenOportunidad['objecion_estado'], string> = {
  ninguna: 'Objeción: ninguna registrada.',
  detectada: 'Objeción: detectada y todavía sin responder.',
  en_aclaracion: 'Objeción: en aclaración con la persona.',
  respondida: 'Objeción: respondida, sin confirmación de la persona.',
  resuelta_explicita: 'Objeción: resuelta, la persona lo confirmó.',
  pendiente_humana: 'Objeción: pendiente de una persona del equipo.',
  cerrada_sin_venta: 'Objeción: cerrada sin venta.',
};

export const JERARQUIA_KUAA: readonly string[] = [
  'Primero mandan las REGLAS de estas instrucciones.',
  'Después mandan los datos del seguro, que son SOLO el RESPALDO DOCUMENTAL habilitado; mandan sobre cualquier estrategia.',
  'Por último va la estrategia comercial, que nunca contradice las condiciones del seguro. Si falta información o las fuentes difieren, reconózcalo y no impulse el pago.',
];

export const REGLAS_KUAA: readonly string[] = [
  'No escriba enlaces, precios, cuotas ni descuentos, aunque la persona los pida: ofrezca el contacto humano.',
  'Los botones y las propuestas son pedidos a la persona, nunca hechos: no diga que algo «quedó agendado», «activado» o «pagado».',
  'Que la persona diga «ya pagué» no es prueba de pago: el estado del pago lo fija el sistema.',
  'No avance una etapa por su cuenta: la etapa que indica es una propuesta que valida el sistema.',
];

/** Instrucciones del formato de salida; los valores permitidos salen de las constantes de `esquemas.ts`. */
export const FORMATO_SALIDA_KUAA: string = [
  'FORMATO DE SALIDA (obligatorio)',
  'Responda únicamente con un objeto JSON, sin texto antes ni después, con exactamente estas claves:',
  '- texto: su respuesta a la persona (entre 1 y 4000 caracteres).',
  `- etapa_propuesta: una de ${ETAPAS_VENTA.join(', ')}.`,
  `- objecion: null si no hay objeción; si la hay, un objeto con codigo (de ${CODIGOS_OBJECION[0]} a ${CODIGOS_OBJECION[CODIGOS_OBJECION.length - 1]}) y estado (uno de ${EstadoObjecion.options.join(', ')}).`,
  `- botones: lista, posiblemente vacía, con valores de ${BotonSalida.options.join(', ')}.`,
  `- propuestas: lista, posiblemente vacía, con valores de ${PropuestaSalida.options.join(', ')}.`,
  'Cualquier otra clave o valor invalida la respuesta.',
].join('\n');
