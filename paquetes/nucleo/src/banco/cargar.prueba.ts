/** Pruebas del cargador del banco de respuestas. Datos sintéticos. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorBanco, cargarBanco } from './cargar.js';

const EJEMPLO = readFileSync(new URL('./banco-ejemplo.json', import.meta.url), 'utf8');

const respuesta = (cambios: Record<string, unknown> = {}) => ({
  id: 'r-uno',
  tema: 'precio_plan',
  preguntas: ['pregunta sintetica uno'],
  plantilla: 'Texto sintético {{premio_plan}}.',
  aprobado_por: 'ejemplo sintetico',
  riesgo: 'normal',
  ...cambios,
});
const banco = (cambios: Record<string, unknown> = {}) => ({ formato: 1, version: '1.0.0', respuestas: [respuesta()], ...cambios });
const texto = (o: unknown) => JSON.stringify(o);

function falla(contenido: string, opciones?: { sha256Esperado?: string }): ErrorBanco {
  try {
    cargarBanco(contenido, opciones);
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorBanco);
    return e as ErrorBanco;
  }
  throw new Error('debía fallar');
}

describe('cargarBanco', () => {
  it('el banco de ejemplo carga y su SHA-256 es estable', () => {
    const { banco: b, sha256 } = cargarBanco(EJEMPLO);
    expect(b.respuestas).toHaveLength(4);
    expect(b.derivaciones).toHaveLength(2);
    expect(sha256).toBe(createHash('sha256').update(EJEMPLO, 'utf8').digest('hex'));
    expect(cargarBanco(EJEMPLO + ' ').sha256).not.toBe(sha256);
  });

  it('el SHA-256 es estable y cambia con un byte', () => {
    const t = texto(banco());
    const { sha256 } = cargarBanco(t);
    expect(sha256).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
    expect(cargarBanco(t + ' ').sha256).not.toBe(sha256);
  });

  it('acepta el sha256Esperado correcto', () => {
    const t = texto(banco());
    const { sha256 } = cargarBanco(t);
    expect(cargarBanco(t, { sha256Esperado: sha256 }).sha256).toBe(sha256);
  });

  it('rechaza un sha256Esperado distinto sin mostrar ningún hash', () => {
    const t = texto(banco());
    const real = cargarBanco(t).sha256;
    const esperado = 'a'.repeat(64);
    const e = falla(t, { sha256Esperado: esperado });
    const visible = `${e.message} ${e.detalles.join(' ')}`;
    expect(e.message).toBe('sha256 no coincide');
    expect(visible).not.toContain(real);
    expect(visible).not.toContain(esperado);
  });

  it('rechaza JSON roto', () => {
    expect(falla('{ no es json').message).toBe('JSON inválido');
  });

  it('rechaza una entrada sin aprobado_por y señala la ruta', () => {
    const r: Record<string, unknown> = respuesta();
    delete r['aprobado_por'];
    const e = falla(texto(banco({ respuestas: [r] })));
    expect(e.message).toBe('banco inválido');
    expect(e.detalles.some((d) => d.startsWith('respuestas.0.aprobado_por'))).toBe(true);
  });

  it('rechaza una variable desconocida', () => {
    const e = falla(texto(banco({ respuestas: [respuesta({ plantilla: 'Hola {{inventada}}' })] })));
    expect(e.detalles).toEqual(['respuestas.0.plantilla: variable desconocida']);
  });

  it('rechaza llaves mal formadas', () => {
    const e = falla(texto(banco({ respuestas: [respuesta({ plantilla: 'Hola {{premio_plan' })] })));
    expect(e.detalles).toEqual(['respuestas.0.plantilla: llaves mal formadas']);
  });

  it('rechaza un valor con forma de secreto sin mostrarlo', () => {
    const clave = 'AIza' + 'B'.repeat(30);
    const e = falla(texto(banco({ descripcion: clave })));
    expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain(clave);
    expect(e.detalles.some((d) => d.startsWith('banco.descripcion'))).toBe(true);
  });

  it('rechaza una clave extra en la raíz', () => {
    expect(falla(texto(banco({ extra: 1 }))).message).toBe('banco inválido');
  });

  it('reúne varios hallazgos en una sola excepción', () => {
    const e = falla(
      texto(
        banco({
          respuestas: [respuesta({ plantilla: '{{inventada}}' }), respuesta({ id: 'r-dos', plantilla: '{{premio_plan' })],
        }),
      ),
    );
    expect(e.detalles).toHaveLength(2);
  });
});
