/**
 * CONJUNTO DE EVALUACIÓN DEL BANCO (modelo híbrido, H3)
 *
 * Por qué existe: para fijar los umbrales de similitud hace falta un conjunto de mensajes con la respuesta
 * correcta conocida, dividido en dos particiones: `calibracion` (con ella se elige el umbral) y `control` (con
 * ella se comprueba que el umbral elegido no se ajustó solo a los casos que lo eligieron). Cada caso dice qué debía
 * pasar: `respuesta` o `derivacion` de una entrada concreta, o `ninguna` (nada del banco corresponde y el mensaje
 * debe seguir a la IA).
 *
 * Defecto que motiva el control: un conjunto de evaluación con una entrada inexistente, con una entrada de
 * respuesta etiquetada como derivación, o con un caso `ninguna` que además nombra una entrada, mide otra cosa
 * distinta de la que se cree y produce un umbral que parece bueno. Todo es estricto (`.strict()`), los ids de
 * caso no se repiten y cada `entradaId` se contrasta con el banco al cargar. Los errores nunca muestran valores
 * (ni textos de casos ni hashes).
 *
 * Qué NO garantiza: que los casos sean representativos del tráfico real, ni que haya suficientes (los mínimos de
 * D8 los exige `medir.ts` al aceptar una calibración, no este esquema), ni que los textos no contengan datos
 * personales (solo frena textos con forma de secreto, como el cargador del banco): el conjunto vive en un bucket, nunca en el repositorio, y su texto no va a la bitácora. El archivo
 * versionado es solo un ejemplo sintético. No hace red ni lee archivos: recibe el texto ya leído.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { pareceSecreto } from '../configuracion/cargar.js';
import type { BancoRespuestas } from './esquema.js';
import { ID_ENTRADA } from './esquema.js';

export const TIPOS_ESPERADOS = ['respuesta', 'derivacion', 'ninguna'] as const;
export const PARTICIONES = ['calibracion', 'control'] as const;

export const Esperado = z
  .object({
    tipo: z.enum(TIPOS_ESPERADOS),
    entradaId: z.string().regex(ID_ENTRADA).optional(),
  })
  .strict();
export type Esperado = z.infer<typeof Esperado>;

export const CasoEvaluacion = z
  .object({
    id: z.string().regex(ID_ENTRADA),
    texto: z.string().trim().min(1).max(1000),
    esperado: Esperado,
    particion: z.enum(PARTICIONES),
  })
  .strict();
export type CasoEvaluacion = z.infer<typeof CasoEvaluacion>;

export const Evaluacion = z
  .object({
    formato: z.literal(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    casos: z.array(CasoEvaluacion).min(1).max(5000),
  })
  .strict()
  .superRefine((e, ctx) => {
    const vistos = new Set<string>();
    e.casos.forEach((c, i) => {
      if (vistos.has(c.id)) ctx.addIssue({ code: 'custom', message: 'id de caso repetido', path: ['casos', i, 'id'] });
      vistos.add(c.id);
      const tieneEntrada = c.esperado.entradaId !== undefined;
      if (c.esperado.tipo === 'ninguna' && tieneEntrada) {
        ctx.addIssue({ code: 'custom', message: 'un caso «ninguna» no lleva entradaId', path: ['casos', i, 'esperado', 'entradaId'] });
      }
      if (c.esperado.tipo !== 'ninguna' && !tieneEntrada) {
        ctx.addIssue({ code: 'custom', message: 'el caso necesita entradaId', path: ['casos', i, 'esperado', 'entradaId'] });
      }
    });
  });
export type Evaluacion = z.infer<typeof Evaluacion>;

export class ErrorEvaluacion extends Error {
  constructor(
    mensaje: string,
    public readonly detalles: string[] = [],
  ) {
    super(mensaje);
    this.name = 'ErrorEvaluacion';
  }
}

export interface EvaluacionCargada {
  evaluacion: Evaluacion;
  sha256: string;
}

export function cargarEvaluacion(contenido: string, banco: BancoRespuestas, opciones: { sha256Esperado?: string } = {}): EvaluacionCargada {
  const sha256 = createHash('sha256').update(contenido, 'utf8').digest('hex');
  if (opciones.sha256Esperado !== undefined && opciones.sha256Esperado.toLowerCase() !== sha256) {
    throw new ErrorEvaluacion('sha256 no coincide');
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(contenido);
  } catch {
    throw new ErrorEvaluacion('JSON inválido');
  }

  const analisis = Evaluacion.safeParse(crudo);
  if (!analisis.success) {
    throw new ErrorEvaluacion(
      'evaluación inválida',
      analisis.error.issues.map((i) => {
        const ruta = i.path.join('.') || '(raíz)';
        // Zod nombra la clave sobrante en su mensaje; podría ser un secreto pegado por error.
        return i.code === 'unrecognized_keys' ? `${ruta}: clave no admitida` : `${ruta}: ${i.message}`;
      }),
    );
  }
  const evaluacion = analisis.data;

  const idsRespuesta = new Set(banco.respuestas.map((r) => r.id));
  const idsDerivacion = new Set(banco.derivaciones.map((d) => d.id));
  const detalles: string[] = [];
  evaluacion.casos.forEach((c, i) => {
    const id = c.esperado.entradaId;
    if (id === undefined) return;
    const conjunto = c.esperado.tipo === 'respuesta' ? idsRespuesta : idsDerivacion;
    if (!conjunto.has(id)) detalles.push(`casos.${i}.esperado.entradaId: no existe en el banco como ${c.esperado.tipo}`);
  });
  if (detalles.length > 0) throw new ErrorEvaluacion('evaluación inválida', detalles);

  // Un texto con forma de secreto no entra: el error da solo la ruta del campo, nunca el valor.
  const secretos: string[] = [];
  evaluacion.casos.forEach((c, i) => {
    if (pareceSecreto(c.texto)) secretos.push(`casos.${i}.texto: el valor parece un secreto`);
  });
  if (secretos.length > 0) throw new ErrorEvaluacion('la evaluación contiene valores con forma de secreto', secretos);

  return { evaluacion, sha256 };
}
