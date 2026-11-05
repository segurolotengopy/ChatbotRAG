/**
 * CALIBRACIÓN DEL BANCO (modelo híbrido, H4a): el archivo `calibracion.json` y su verificación
 *
 * Por qué existe: H3 mide umbrales, pero un umbral solo vale para el banco, el modelo y la dimensión con los que se
 * midió (D9: no vive en el código). Este módulo define la forma estricta del archivo que acompaña al banco en el
 * bucket y decide, con datos, si la vía semántica puede usarse (`semanticaApta`) y si además puede responder con
 * textos fijos (`fijoApto`, que es D4 hecha código: confusión 0 y falsos positivos 0 en el control).
 *
 * Defecto que motiva el control: una calibración vieja (otro banco, otro modelo, otra dimensión), inválida o medida
 * con el proveedor simulado (sin semántica) aplicada en producción daría respuestas fijas equivocadas con la
 * autoridad de «texto aprobado». Ante cualquier discrepancia la respuesta es «no apta» y el mensaje va a la IA.
 * Una derivación por coincidencia exacta no necesita calibración (no pasa por aquí).
 *
 * Coherencia: el archivo se rechaza si se contradice (`valido` sí y hay motivos de invalidez, o `valido` no y no hay
 * ninguno; confusiones o falsos positivos en el control sin su motivo; `valido` con un control vacío o menor que el
 * mínimo de casos «ninguna» de `medir.ts`; `umbral_fijo` bajo el piso del barrido, `umbral_derivacion` no positivo). Un archivo incoherente es un archivo
 * editado a mano o mal generado, y no se usa. El campo `regla` liga la calibración a la versión de la regla de
 * decisión (`VERSION_REGLA_DECISION`): una calibración medida con otra regla no sirve con la actual.
 *
 * Qué NO garantiza: que la medición sea buena (pocos casos o poco variados la sobreestiman; lo dice `control.total`
 * y lo decide quien arma la evaluación), que el SHA-256 de la evaluación corresponda a un archivo real (solo se
 * conserva como constancia) ni que `modelo` sea el correcto más allá de coincidir con el del índice. No lee
 * archivos ni hace red: recibe el texto. Los errores nunca muestran valores del archivo.
 */
import { z } from 'zod';
import { MINIMO_NINGUNA, MOTIVOS_INVALIDEZ, UMBRAL_MINIMO_BARRIDO } from './medir.js';
import { VERSION_REGLA_DECISION } from './similitud.js';
import type { UmbralesSemanticos } from './similitud.js';

const SHA256 = z.string().regex(/^[0-9a-fA-F]{64}$/);

export const PROVEEDORES_CALIBRACION = ['vertex', 'simulado'] as const;

export const Calibracion = z
  .object({
    formato: z.literal(1),
    regla: z.number().int().positive(),
    banco_sha256: SHA256,
    evaluacion_sha256: SHA256,
    proveedor: z.enum(PROVEEDORES_CALIBRACION),
    modelo: z.string().trim().min(1).max(100),
    dimension: z.number().int().positive().max(100_000),
    umbral_fijo: z.number().min(UMBRAL_MINIMO_BARRIDO).max(1),
    // La derivación puede exigir menos que la fija (D7); `barrerUmbrales` llega a 0,01. Solo el umbral fijo tiene piso.
    umbral_derivacion: z.number().gt(0).max(1),
    margen: z.number().min(0).max(1),
    valido: z.boolean(),
    motivos_invalidez: z.array(z.enum(MOTIVOS_INVALIDEZ)).max(MOTIVOS_INVALIDEZ.length),
    control: z
      .object({
        total: z.number().int().nonnegative(),
        confusiones: z.number().int().nonnegative(),
        falsos_positivos: z.number().int().nonnegative(),
      })
      .strict(),
    medido: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  })
  .strict()
  .superRefine((c, ctx) => {
    const falla = (message: string, path: string[]) => ctx.addIssue({ code: 'custom', message, path });
    if (c.valido !== (c.motivos_invalidez.length === 0)) falla('valido y motivos_invalidez se contradicen', ['valido']);
    if (c.control.confusiones > 0 && !c.motivos_invalidez.includes('confusion_en_control')) falla('falta el motivo confusion_en_control', ['motivos_invalidez']);
    if (c.control.falsos_positivos > 0 && !c.motivos_invalidez.includes('falso_positivo_en_control')) {
      falla('falta el motivo falso_positivo_en_control', ['motivos_invalidez']);
    }
    if (c.valido && (c.control.total === 0 || c.control.total < MINIMO_NINGUNA)) falla('control insuficiente para una calibración válida', ['control', 'total']);
  });
export type Calibracion = z.infer<typeof Calibracion>;

export class ErrorCalibracion extends Error {
  constructor(
    mensaje: string,
    public readonly detalles: string[] = [],
  ) {
    super(mensaje);
    this.name = 'ErrorCalibracion';
  }
}

/** Lee y valida el texto de `calibracion.json`. Los mensajes no incluyen valores del archivo. */
export function cargarCalibracion(contenido: string): Calibracion {
  let crudo: unknown;
  try {
    crudo = JSON.parse(contenido);
  } catch {
    throw new ErrorCalibracion('JSON inválido');
  }
  const analisis = Calibracion.safeParse(crudo);
  if (!analisis.success) {
    throw new ErrorCalibracion(
      'calibración inválida',
      analisis.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.code === 'unrecognized_keys' ? 'clave no admitida' : i.message}`),
    );
  }
  return analisis.data;
}

export interface EsperadoCalibracion {
  /** SHA-256 del banco cargado (el que devuelve `cargarBanco`). */
  bancoSha256: string;
  /** Nombre y dimensión del embebedor con el que se construyó el índice semántico. */
  modelo: string;
  dimension: number;
  /** Solo pruebas: admite una calibración medida con el proveedor simulado. */
  admitirSimulado?: boolean;
}

export interface VerificacionCalibracion {
  /** Se puede proponer derivaciones por similitud. */
  semanticaApta: boolean;
  /** Además se puede proponer respuestas fijas por similitud (D4: control sin confusiones ni falsos positivos). */
  fijoApto: boolean;
}

export function verificarCalibracion(cal: Calibracion, esperado: EsperadoCalibracion): VerificacionCalibracion {
  const semanticaApta =
    cal.regla === VERSION_REGLA_DECISION &&
    cal.valido &&
    cal.banco_sha256.toLowerCase() === esperado.bancoSha256.toLowerCase() &&
    cal.modelo === esperado.modelo &&
    cal.dimension === esperado.dimension &&
    (cal.proveedor !== 'simulado' || esperado.admitirSimulado === true);
  const fijoApto = semanticaApta && cal.control.confusiones === 0 && cal.control.falsos_positivos === 0;
  return { semanticaApta, fijoApto };
}

export function umbralesDeCalibracion(cal: Calibracion): UmbralesSemanticos {
  return { umbralFijo: cal.umbral_fijo, umbralDerivacion: cal.umbral_derivacion, margen: cal.margen };
}
