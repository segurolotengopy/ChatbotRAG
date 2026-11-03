/** Pruebas de las plantillas del banco. Datos sintéticos. */
import { describe, expect, it } from 'vitest';
import type { VariablePlantilla } from './esquema.js';
import { ErrorPlantilla, rellenarPlantilla, variablesDe, type ResolverVariables } from './plantillas.js';

const resolver: ResolverVariables = (v: VariablePlantilla) => ({ premio_plan: '390.000', nombre_plan: 'Plan Ejemplo', whatsapp: '+595 000 000 000' })[v as 'premio_plan'] ?? null;

describe('variablesDe', () => {
  it('plantilla sin variables', () => {
    expect(variablesDe('Texto plano.')).toEqual({ conocidas: [], desconocidas: [], malformada: false });
  });
  it('variable repetida se informa una vez', () => {
    expect(variablesDe('{{premio_plan}} y {{ premio_plan }}').conocidas).toEqual(['premio_plan']);
  });
  it('variable desconocida', () => {
    expect(variablesDe('{{inventada}}')).toEqual({ conocidas: [], desconocidas: ['inventada'], malformada: false });
  });
  it.each(['{{premio_plan sin cerrar', 'sobra }} suelto', 'un { x } suelto'])('malformada: %s', (t) => {
    expect(variablesDe(t).malformada).toBe(true);
  });
});

describe('rellenarPlantilla', () => {
  it('sin variables devuelve el texto', () => {
    expect(rellenarPlantilla('Hola.', resolver)).toEqual({ ok: true, texto: 'Hola.' });
  });
  it('rellena variables repetidas', () => {
    expect(rellenarPlantilla('{{nombre_plan}}: {{premio_plan}} ({{nombre_plan}})', resolver)).toEqual({
      ok: true,
      texto: 'Plan Ejemplo: 390.000 (Plan Ejemplo)',
    });
  });
  it('informa faltantes sin repetidos y en orden', () => {
    expect(rellenarPlantilla('{{correo_derechos}} {{premio_plan}} {{canal_contacto}} {{correo_derechos}}', resolver)).toEqual({
      ok: false,
      faltantes: ['correo_derechos', 'canal_contacto'],
    });
  });
  it('un valor vacío cuenta como faltante', () => {
    expect(rellenarPlantilla('{{premio_plan}}', () => '')).toEqual({ ok: false, faltantes: ['premio_plan'] });
  });
  it('una variable desconocida lanza', () => {
    expect(() => rellenarPlantilla('{{inventada}}', resolver)).toThrow(ErrorPlantilla);
  });
  it('un valor que contiene {{whatsapp}} no se reinterpreta y lanza', () => {
    expect(() => rellenarPlantilla('{{premio_plan}}', () => '{{whatsapp}}')).toThrow(ErrorPlantilla);
  });
  it('el error no incluye el valor resuelto', () => {
    try {
      rellenarPlantilla('{{premio_plan}}', () => '{{valor-secreto}}');
    } catch (e) {
      expect(e).toBeInstanceOf(ErrorPlantilla);
      expect((e as Error).message).toBe('plantilla sin rellenar');
      return;
    }
    throw new Error('debía lanzar');
  });
  it('nunca sale texto con llaves: cada caso lanza o sale limpio, y se distingue cuál', () => {
    const casos: [string, 'lanza' | 'limpio'][] = [
      ['{{premio_plan', 'lanza'],
      ['a }} b', 'lanza'],
      ['{ x }', 'lanza'],
      ['{{premio_plan}} {', 'lanza'],
      ['{{premio_plan}} y {{nombre_plan}}', 'limpio'],
    ];
    for (const [t, esperado] of casos) {
      let resultado: 'lanza' | 'limpio' = 'limpio';
      try {
        const r = rellenarPlantilla(t, resolver);
        if (r.ok) expect(r.texto).not.toMatch(/[{}]/);
      } catch (e) {
        expect(e).toBeInstanceOf(ErrorPlantilla);
        resultado = 'lanza';
      }
      expect(resultado, t).toBe(esperado);
    }
  });
});
