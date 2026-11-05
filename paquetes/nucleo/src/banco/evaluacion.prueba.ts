/** Pruebas del conjunto de evaluación. Datos sintéticos. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cargarBanco } from './cargar.js';
import { ErrorEvaluacion, cargarEvaluacion } from './evaluacion.js';

const BANCO = cargarBanco(readFileSync(new URL('./banco-ejemplo.json', import.meta.url), 'utf8'), { admitirSintetico: true }).banco;
const EJEMPLO = readFileSync(new URL('./evaluacion-ejemplo.json', import.meta.url), 'utf8');

const caso = (cambios: Record<string, unknown> = {}) => ({
  id: 'caso-uno',
  texto: 'texto sintetico uno',
  esperado: { tipo: 'respuesta', entradaId: 'ejemplo-contacto' },
  particion: 'control',
  ...cambios,
});
const evaluacion = (casos: unknown[] = [caso()], extra: Record<string, unknown> = {}) => JSON.stringify({ formato: 1, version: '1.0.0', casos, ...extra });

function falla(contenido: string, opciones?: { sha256Esperado?: string }): ErrorEvaluacion {
  try {
    cargarEvaluacion(contenido, BANCO, opciones);
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorEvaluacion);
    return e as ErrorEvaluacion;
  }
  throw new Error('debía fallar');
}

describe('cargarEvaluacion', () => {
  it('el ejemplo carga, cumple los mínimos de D8 y su SHA-256 es estable', () => {
    const { evaluacion: e, sha256 } = cargarEvaluacion(EJEMPLO, BANCO);
    expect(sha256).toBe(createHash('sha256').update(EJEMPLO, 'utf8').digest('hex'));
    expect(e.casos).toHaveLength(114);
    for (const particion of ['calibracion', 'control']) {
      expect(e.casos.filter((c) => c.particion === particion && c.esperado.tipo === 'ninguna')).toHaveLength(32);
      expect(e.casos.filter((c) => c.particion === particion && c.esperado.entradaId === 'ejemplo-contacto')).toHaveLength(5);
    }
  });

  it('acepta un caso válido de cada tipo', () => {
    const casos = [
      caso({ id: 'c-uno' }),
      caso({ id: 'c-dos', esperado: { tipo: 'derivacion', entradaId: 'ejemplo-siniestro' }, particion: 'calibracion' }),
      caso({ id: 'c-tres', esperado: { tipo: 'ninguna' } }),
    ];
    expect(cargarEvaluacion(evaluacion(casos), BANCO).evaluacion.casos).toHaveLength(3);
  });

  it('rechaza claves de más sin nombrarlas', () => {
    for (const contenido of [
      evaluacion([caso()], { extra: 1 }),
      evaluacion([caso({ otra: 'CLAVE-SECRETA-SINTETICA' })]),
      evaluacion([caso({ esperado: { tipo: 'ninguna', pista: 'x' } })]),
    ]) {
      const e = falla(contenido);
      expect(e.detalles.some((d) => d.endsWith('clave no admitida'))).toBe(true);
      expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain('CLAVE-SECRETA-SINTETICA');
    }
  });

  it('rechaza un entradaId inexistente o del tipo equivocado', () => {
    expect(falla(evaluacion([caso({ esperado: { tipo: 'respuesta', entradaId: 'no-existe' } })])).detalles).toEqual([
      'casos.0.esperado.entradaId: no existe en el banco como respuesta',
    ]);
    // «ejemplo-siniestro» es una derivación, no una respuesta.
    expect(falla(evaluacion([caso({ esperado: { tipo: 'respuesta', entradaId: 'ejemplo-siniestro' } })])).detalles).toHaveLength(1);
    expect(falla(evaluacion([caso({ esperado: { tipo: 'derivacion', entradaId: 'ejemplo-contacto' } })])).detalles).toHaveLength(1);
  });

  it('«ninguna» no lleva entradaId y los demás tipos sí', () => {
    expect(falla(evaluacion([caso({ esperado: { tipo: 'ninguna', entradaId: 'ejemplo-contacto' } })])).detalles.join(' ')).toContain('no lleva entradaId');
    expect(falla(evaluacion([caso({ esperado: { tipo: 'respuesta' } })])).detalles.join(' ')).toContain('necesita entradaId');
  });

  it('rechaza id repetido, partición inválida, texto vacío, sin casos y formato distinto', () => {
    expect(falla(evaluacion([caso(), caso()])).detalles.join(' ')).toContain('id de caso repetido');
    expect(() => cargarEvaluacion(evaluacion([caso({ particion: 'otra' })]), BANCO)).toThrow(ErrorEvaluacion);
    expect(() => cargarEvaluacion(evaluacion([caso({ texto: '   ' })]), BANCO)).toThrow(ErrorEvaluacion);
    expect(() => cargarEvaluacion(evaluacion([]), BANCO)).toThrow(ErrorEvaluacion);
    expect(() => cargarEvaluacion(JSON.stringify({ formato: 2, version: '1.0.0', casos: [caso()] }), BANCO)).toThrow(ErrorEvaluacion);
  });

  it('JSON inválido y SHA-256 distinto fallan sin mostrar valores', () => {
    expect(falla('{no es json').message).toBe('JSON inválido');
    const t = evaluacion();
    const e = falla(t, { sha256Esperado: 'a'.repeat(64) });
    expect(e.message).toBe('sha256 no coincide');
    expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain(createHash('sha256').update(t, 'utf8').digest('hex'));
    const { sha256 } = cargarEvaluacion(t, BANCO);
    expect(cargarEvaluacion(t, BANCO, { sha256Esperado: sha256.toUpperCase() }).sha256).toBe(sha256);
  });

  it('rechaza un texto con forma de secreto y da solo la ruta del campo', () => {
    const secreto = `sk-${'a1B2c3D4'.repeat(4)}`;
    const e = falla(evaluacion([caso(), caso({ id: 'caso-dos', texto: `mi clave ${secreto}` })]));
    expect(e.detalles).toEqual(['casos.1.texto: el valor parece un secreto']);
    expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain(secreto);
  });

  it('los errores de forma no repiten el texto de los casos', () => {
    const e = falla(evaluacion([caso({ texto: 'TEXTO-SINTETICO-SECRETO', particion: 'otra' })]));
    expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain('TEXTO-SINTETICO-SECRETO');
  });
});

describe('estructura', () => {
  it('el archivo no usa red, entorno ni expresiones construidas', () => {
    const fuente = readFileSync(new URL('./evaluacion.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Math.random']) expect(fuente).not.toContain(prohibido);
  });
});
