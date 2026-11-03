/**
 * ESQUEMA DEL BANCO DE RESPUESTAS (modelo híbrido, H1)
 *
 * Por qué existe: en el modelo híbrido, las preguntas frecuentes y los casos que exigen derivación a una persona
 * se contestan con textos APROBADOS por una persona responsable, no generados por el modelo. Este esquema fija la
 * forma de ese banco para que un texto sin responsable, con una variable inventada o con claves de más no entre.
 *
 * Defecto que motiva el control: un banco editado a mano que acepta cualquier clave o cualquier variable termina
 * entregando al cliente texto con llaves sin rellenar, importes que nadie aprobó o respuestas sin dueño. Por eso
 * todo es estricto (`.strict()`), las variables son una lista cerrada y `aprobado_por` es obligatorio y sin
 * valor por defecto.
 *
 * Qué NO garantiza: que el texto de una respuesta sea correcto, completo o conveniente. Eso lo da quien figura en
 * `aprobado_por` (nombre o rol, texto corto, sin fecha). El banco vive en un bucket, nunca en el repositorio, y
 * `aprobado_por` no va a la bitácora.
 */
import { z } from 'zod';
import { normalizar } from '../compuertas/vocabulario.js';

export const VARIABLES_PLANTILLA = [
  'nombre_plan',
  'premio_plan',
  'capital_fallecimiento_plan',
  'indemnizacion_cancer_plan',
  'renta_hospitalaria_dia_plan',
  'renta_dias_max_plan',
  'gastos_medicos_accidente_plan',
  'whatsapp',
  'canal_contacto',
  'correo_derechos',
] as const;
export const VariablePlantilla = z.enum(VARIABLES_PLANTILLA);
export type VariablePlantilla = z.infer<typeof VariablePlantilla>;

/** Variables que dependen del plan elegido (las terminadas en `_plan`). */
export const VARIABLES_DE_PLAN: ReadonlySet<VariablePlantilla> = new Set(VARIABLES_PLANTILLA.filter((v) => v.endsWith('_plan')));

export const MOTIVOS_DERIVACION = [
  'emergencia',
  'siniestro_particular',
  'pago_o_expediente',
  'evaluacion_individual',
  'contenido_pendiente',
  'atencion_humana_ya_solicitada',
] as const;
export const MotivoDerivacion = z.enum(MOTIVOS_DERIVACION);
export type MotivoDerivacion = z.infer<typeof MotivoDerivacion>;

export const CONDICIONES_DERIVACION = ['contenido_pendiente', 'atencion_humana_solicitada', 'sin_dato'] as const;
export const CondicionDerivacion = z.enum(CONDICIONES_DERIVACION);
export type CondicionDerivacion = z.infer<typeof CondicionDerivacion>;

/** Provisional: la lista definitiva la fija Rodrigo. */
export const RIESGOS = ['normal', 'critico'] as const;
export const Riesgo = z.enum(RIESGOS);
export type Riesgo = z.infer<typeof Riesgo>;

export const ID_ENTRADA = /^[A-Za-z0-9][A-Za-z0-9_.-]{1,63}$/;
export const TEMA = /^[a-z0-9_]{2,40}$/;

const APROBADO_POR = z.string().regex(/^[\p{L}\p{N} ,._-]{2,80}$/u);
const TEXTO = (max: number) => z.string().trim().min(1).max(max);

export const EntradaRespuesta = z
  .object({
    id: z.string().regex(ID_ENTRADA),
    tema: z.string().regex(TEMA),
    preguntas: z.array(TEXTO(300)).min(1).max(30),
    plantilla: TEXTO(1500),
    aprobado_por: APROBADO_POR,
    riesgo: Riesgo,
    derivar_cuando: z.array(CondicionDerivacion).max(3).default([]),
  })
  .strict();
export type EntradaRespuesta = z.infer<typeof EntradaRespuesta>;

export const EntradaDerivacion = z
  .object({
    id: z.string().regex(ID_ENTRADA),
    motivo: MotivoDerivacion.exclude(['atencion_humana_ya_solicitada', 'contenido_pendiente']),
    preguntas: z.array(TEXTO(300)).max(60).default([]),
    terminos: z.array(z.string().regex(/^[\p{L}\p{N} ]{3,40}$/u)).max(200).default([]),
    texto: TEXTO(600),
    aprobado_por: APROBADO_POR,
  })
  .strict()
  .refine((e) => e.terminos.length === 0 || e.motivo === 'emergencia', {
    message: 'los términos solo se admiten con el motivo emergencia',
    path: ['terminos'],
  });
export type EntradaDerivacion = z.infer<typeof EntradaDerivacion>;

export const TextoMotivo = z
  .object({
    motivo: MotivoDerivacion,
    texto: TEXTO(600),
    aprobado_por: APROBADO_POR,
  })
  .strict();
export type TextoMotivo = z.infer<typeof TextoMotivo>;

const Aclaracion = z.object({ texto: TEXTO(400), aprobado_por: APROBADO_POR }).strict();

export const Aclaraciones = z
  .object({
    ambigua: Aclaracion.optional(),
    falta_plan: Aclaracion.optional(),
  })
  .strict();
export type Aclaraciones = z.infer<typeof Aclaraciones>;

export const BancoRespuestas = z
  .object({
    formato: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    descripcion: TEXTO(300).optional(),
    respuestas: z.array(EntradaRespuesta).max(500),
    derivaciones: z.array(EntradaDerivacion).max(20).default([]),
    textos_derivacion: z.array(TextoMotivo).max(6).default([]),
    aclaraciones: Aclaraciones.prefault({}),
  })
  .strict()
  .superRefine((banco, ctx) => {
    const vistos = new Set<string>();
    const registrarId = (id: string, ruta: (string | number)[]) => {
      if (vistos.has(id)) ctx.addIssue({ code: 'custom', message: 'id repetido', path: ruta });
      vistos.add(id);
    };
    banco.respuestas.forEach((e, i) => registrarId(e.id, ['respuestas', i, 'id']));
    banco.derivaciones.forEach((e, i) => registrarId(e.id, ['derivaciones', i, 'id']));

    const motivos = new Set<string>();
    banco.textos_derivacion.forEach((t, i) => {
      if (motivos.has(t.motivo)) ctx.addIssue({ code: 'custom', message: 'motivo repetido', path: ['textos_derivacion', i, 'motivo'] });
      motivos.add(t.motivo);
    });

    const sinRepetir = (preguntas: string[], ruta: (string | number)[]) => {
      const normalizadas = new Set<string>();
      preguntas.forEach((p, j) => {
        const n = normalizar(p);
        if (normalizadas.has(n)) ctx.addIssue({ code: 'custom', message: 'pregunta repetida', path: [...ruta, j] });
        normalizadas.add(n);
      });
    };
    banco.respuestas.forEach((e, i) => sinRepetir(e.preguntas, ['respuestas', i, 'preguntas']));
    banco.derivaciones.forEach((e, i) => sinRepetir(e.preguntas, ['derivaciones', i, 'preguntas']));
  });
export type BancoRespuestas = z.infer<typeof BancoRespuestas>;
