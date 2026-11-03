/** Pruebas del esquema del banco de respuestas. Datos sintéticos. */
import { describe, expect, it } from 'vitest';
import { Aclaraciones, BancoRespuestas, EntradaDerivacion, EntradaRespuesta, TextoMotivo, normalizarPregunta } from './esquema.js';

const respuesta = (cambios: Record<string, unknown> = {}) => ({
  id: 'r-uno',
  tema: 'precio_plan',
  preguntas: ['¿cuánto cuesta?'],
  plantilla: 'Texto sintético {{premio_plan}}.',
  aprobado_por: 'ejemplo sintetico',
  riesgo: 'normal',
  ...cambios,
});
const banco = (cambios: Record<string, unknown> = {}) => ({ formato: 1, version: '1.0.0', respuestas: [respuesta()], ...cambios });

describe('esquema del banco de respuestas', () => {
  it('acepta un banco mínimo y aplica los valores por defecto', () => {
    const b = BancoRespuestas.parse(banco());
    expect(b.derivaciones).toEqual([]);
    expect(b.textos_derivacion).toEqual([]);
    expect(b.aclaraciones).toEqual({});
    expect(b.respuestas[0]?.derivar_cuando).toEqual([]);
  });

  it('rechaza una entrada sin aprobado_por', () => {
    const sin: Record<string, unknown> = respuesta();
    delete sin['aprobado_por'];
    expect(EntradaRespuesta.safeParse(sin).success).toBe(false);
  });

  it('rechaza aprobado_por vacío', () => {
    expect(EntradaRespuesta.safeParse(respuesta({ aprobado_por: '' })).success).toBe(false);
  });

  it('rechaza una clave extra', () => {
    expect(EntradaRespuesta.safeParse(respuesta({ extra: 1 })).success).toBe(false);
    expect(BancoRespuestas.safeParse(banco({ extra: 1 })).success).toBe(false);
  });

  it('rechaza un riesgo fuera de la lista', () => {
    expect(EntradaRespuesta.safeParse(respuesta({ riesgo: 'alto' })).success).toBe(false);
  });

  it('rechaza ids duplicados entre respuestas y derivaciones', () => {
    const derivacion = { id: 'r-uno', motivo: 'siniestro_particular', texto: 'Texto', aprobado_por: 'ejemplo sintetico' };
    expect(BancoRespuestas.safeParse(banco({ derivaciones: [derivacion] })).success).toBe(false);
    expect(BancoRespuestas.safeParse(banco({ respuestas: [respuesta(), respuesta()] })).success).toBe(false);
  });

  it('rechaza términos en un motivo distinto de emergencia', () => {
    const base = { id: 'd-uno', texto: 'Texto', aprobado_por: 'ejemplo sintetico', terminos: ['termino de prueba'] };
    expect(EntradaDerivacion.safeParse({ ...base, motivo: 'siniestro_particular' }).success).toBe(false);
    expect(EntradaDerivacion.safeParse({ ...base, motivo: 'emergencia' }).success).toBe(true);
  });

  it('rechaza motivos de derivación reservados a otros mecanismos', () => {
    const base = { id: 'd-uno', texto: 'Texto', aprobado_por: 'ejemplo sintetico' };
    expect(EntradaDerivacion.safeParse({ ...base, motivo: 'contenido_pendiente' }).success).toBe(false);
    expect(EntradaDerivacion.safeParse({ ...base, motivo: 'atencion_humana_ya_solicitada' }).success).toBe(false);
  });

  it('rechaza preguntas repetidas tras normalizar y motivos repetidos en textos_derivacion', () => {
    expect(BancoRespuestas.safeParse(banco({ respuestas: [respuesta({ preguntas: ['Cuánto  cuesta', 'cuanto cuesta'] })] })).success).toBe(false);
    const t = { motivo: 'emergencia', texto: 'Texto', aprobado_por: 'ejemplo sintetico' };
    expect(BancoRespuestas.safeParse(banco({ textos_derivacion: [t, t] })).success).toBe(false);
  });

  it.each(['   ', '--', ', ', '2026-11-02', 'Ana 2026-11-02', '12345'])('rechaza aprobado_por inválido %j en todas las apariciones', (v) => {
    expect(EntradaRespuesta.safeParse(respuesta({ aprobado_por: v })).success).toBe(false);
    expect(EntradaDerivacion.safeParse({ id: 'd-uno', motivo: 'emergencia', texto: 'T', aprobado_por: v }).success).toBe(false);
    expect(TextoMotivo.safeParse({ motivo: 'emergencia', texto: 'T', aprobado_por: v }).success).toBe(false);
    expect(Aclaraciones.safeParse({ ambigua: { texto: 'T', aprobado_por: v } }).success).toBe(false);
    expect(Aclaraciones.safeParse({ falta_plan: { texto: 'T', aprobado_por: v } }).success).toBe(false);
  });

  it('acepta aprobado_por con nombre o rol y lo recorta', () => {
    expect(EntradaRespuesta.parse(respuesta({ aprobado_por: '  Responsable comercial  ' })).aprobado_por).toBe('Responsable comercial');
  });

  it('rechaza términos de solo espacios o sin letras, y términos repetidos', () => {
    const base = { id: 'd-uno', motivo: 'emergencia', texto: 'T', aprobado_por: 'ejemplo sintetico' };
    expect(EntradaDerivacion.safeParse({ ...base, terminos: ['     '] }).success).toBe(false);
    expect(EntradaDerivacion.safeParse({ ...base, terminos: ['12345'] }).success).toBe(false);
    expect(EntradaDerivacion.safeParse({ ...base, terminos: ['Término uno', 'termino  uno'] }).success).toBe(false);
    expect(EntradaDerivacion.safeParse({ ...base, terminos: ['termino uno', 'termino dos'] }).success).toBe(true);
  });

  it('rechaza preguntas repetidas entre entradas, ignorando puntuación y tildes', () => {
    const otra = respuesta({ id: 'r-dos', preguntas: ['cuanto cuesta'] });
    const primera = respuesta({ preguntas: ['¿Cuánto cuesta?'] });
    expect(BancoRespuestas.safeParse(banco({ respuestas: [primera, otra] })).success).toBe(false);
    const deriv = { id: 'd-uno', motivo: 'siniestro_particular', preguntas: ['CUANTO   cuesta!'], texto: 'T', aprobado_por: 'ejemplo sintetico' };
    expect(BancoRespuestas.safeParse(banco({ respuestas: [primera], derivaciones: [deriv] })).success).toBe(false);
  });

  it('normalizarPregunta quita puntuación y colapsa espacios', () => {
    expect(normalizarPregunta('¿Cuánto   cuesta?')).toBe('cuanto cuesta');
  });

  it('rechaza derivar_cuando con valores repetidos', () => {
    expect(EntradaRespuesta.safeParse(respuesta({ derivar_cuando: ['sin_dato', 'sin_dato'] })).success).toBe(false);
  });

  it('rechaza listas por encima de su máximo y un formato distinto de 1', () => {
    expect(EntradaRespuesta.safeParse(respuesta({ derivar_cuando: ['sin_dato', 'contenido_pendiente', 'atencion_humana_solicitada', 'sin_dato'] })).success).toBe(false);
    const muchas = Array.from({ length: 31 }, (_, i) => `pregunta numero ${i}`);
    expect(EntradaRespuesta.safeParse(respuesta({ preguntas: muchas })).success).toBe(false);
    expect(BancoRespuestas.safeParse(banco({ formato: 2 })).success).toBe(false);
  });
});
