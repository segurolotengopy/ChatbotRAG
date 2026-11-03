/** Pruebas del esquema del banco de respuestas. Datos sintéticos. */
import { describe, expect, it } from 'vitest';
import { BancoRespuestas, EntradaDerivacion, EntradaRespuesta } from './esquema.js';

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
});
