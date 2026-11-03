/** Pruebas del cargador del banco de respuestas. Datos sintéticos. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ErrorBanco, cargarBanco } from './cargar.js';

const cargar = (c: string, o: { sha256Esperado?: string; admitirSintetico?: boolean } = {}) => cargarBanco(c, { admitirSintetico: true, ...o });

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

function falla(contenido: string, opciones?: { sha256Esperado?: string; admitirSintetico?: boolean }): ErrorBanco {
  try {
    cargar(contenido, opciones);
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorBanco);
    return e as ErrorBanco;
  }
  throw new Error('debía fallar');
}

describe('cargarBanco', () => {
  it('el banco de ejemplo carga y su SHA-256 es estable', () => {
    const { banco: b, sha256 } = cargar(EJEMPLO);
    expect(b.respuestas).toHaveLength(4);
    expect(b.derivaciones).toHaveLength(2);
    expect(sha256).toBe(createHash('sha256').update(EJEMPLO, 'utf8').digest('hex'));
    expect(cargar(EJEMPLO + ' ').sha256).not.toBe(sha256);
  });

  it('el SHA-256 es estable y cambia con un byte', () => {
    const t = texto(banco());
    const { sha256 } = cargar(t);
    expect(sha256).toBe(createHash('sha256').update(t, 'utf8').digest('hex'));
    expect(cargar(t + ' ').sha256).not.toBe(sha256);
  });

  it('acepta el sha256Esperado correcto', () => {
    const t = texto(banco());
    const { sha256 } = cargar(t);
    expect(cargar(t, { sha256Esperado: sha256 }).sha256).toBe(sha256);
  });

  it('rechaza un sha256Esperado distinto sin mostrar ningún hash', () => {
    const t = texto(banco());
    const real = cargar(t).sha256;
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
          respuestas: [respuesta({ plantilla: '{{inventada}}' }), respuesta({ id: 'r-dos', preguntas: ['pregunta sintetica dos'], plantilla: '{{premio_plan' })],
        }),
      ),
    );
    expect(e.detalles).toHaveLength(2);
  });

  it('una clave extra no muestra su nombre en ningún detalle ni en el mensaje', () => {
    const nombre = 'AIzaSECRETOxxxxxxxxxxxxxxxx';
    const enRaiz = falla(texto(banco({ [nombre]: 1 })));
    const enEntrada = falla(texto(banco({ respuestas: [respuesta({ [nombre]: 1 })] })));
    for (const e of [enRaiz, enEntrada]) {
      expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain(nombre);
      expect(e.detalles.some((d) => d.endsWith(': clave no admitida'))).toBe(true);
    }
  });

  describe('banco sintético y llaves en textos', () => {
    const real = (cambios: Record<string, unknown> = {}) =>
      banco({ descripcion: 'Banco de prueba real', respuestas: [respuesta({ aprobado_por: 'Rol Comercial' })], ...cambios });
    const derivacion = (cambios: Record<string, unknown> = {}) => ({
      id: 'd-uno',
      motivo: 'emergencia',
      terminos: ['termino real'],
      texto: 'Texto real de derivación.',
      aprobado_por: 'Rol Comercial',
      ...cambios,
    });

    it('el ejemplo sin la opción se rechaza sin pistas en el mensaje', () => {
      const e = falla(EJEMPLO, { admitirSintetico: false });
      expect(e.message).toBe('banco sintético fuera de pruebas');
      expect(e.detalles).toEqual([]);
      for (const c of ['SINTÉTICO', 'ejemplo sintetico', '(ejemplo)']) expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain(c);
      expect(() => cargarBanco(EJEMPLO)).toThrow(ErrorBanco);
    });

    it.each(['Banco sintético', 'BANCOS SINTETICOS'])('rechaza la descripción «%s»', (descripcion) => {
      expect(falla(texto(real({ descripcion })), { admitirSintetico: false }).message).toBe('banco sintético fuera de pruebas');
    });

    it('rechaza un aprobado_por «Ejemplo  Sintético» en derivaciones, textos_derivacion y aclaraciones', () => {
      const marca = 'Ejemplo  Sintético';
      const casos = [
        real({ derivaciones: [derivacion({ aprobado_por: marca })] }),
        real({ textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'Texto real.', aprobado_por: marca }] }),
        real({ aclaraciones: { ambigua: { texto: 'Texto real.', aprobado_por: marca } } }),
      ];
      for (const c of casos) expect(falla(texto(c), { admitirSintetico: false }).message).toBe('banco sintético fuera de pruebas');
    });

    it('un banco con aprobadores reales carga sin la opción', () => {
      const t = texto(real({ derivaciones: [derivacion()] }));
      expect(cargarBanco(t).banco.respuestas).toHaveLength(1);
    });

    it('«Sintetizado por el área comercial» no se rechaza', () => {
      const t = texto(real({ respuestas: [respuesta({ aprobado_por: 'Sintetizado por el área comercial' })] }));
      expect(cargarBanco(t).banco.respuestas).toHaveLength(1);
    });

    it('el SHA erróneo se revisa antes que lo sintético', () => {
      const e = falla(EJEMPLO, { sha256Esperado: 'a'.repeat(64), admitirSintetico: false });
      expect(e.message).toBe('sha256 no coincide');
    });

    it('rechaza llaves en textos de derivación y aclaraciones sin mostrar el texto', () => {
      const marca = 'TextoSecretoQ';
      const e1 = falla(texto(real({ derivaciones: [derivacion({ texto: `${marca} {{whatsapp}}` })] })));
      const e2 = falla(texto(real({ textos_derivacion: [{ motivo: 'contenido_pendiente', texto: `${marca} }`, aprobado_por: 'Rol Comercial' }] })));
      const e3 = falla(texto(real({ aclaraciones: { falta_plan: { texto: `${marca} {`, aprobado_por: 'Rol Comercial' } } })));
      expect(e1.detalles).toEqual(['derivaciones.0.texto: llaves no admitidas']);
      expect(e2.detalles).toEqual(['textos_derivacion.0.texto: llaves no admitidas']);
      expect(e3.detalles).toEqual(['aclaraciones.falta_plan.texto: llaves no admitidas']);
      for (const e of [e1, e2, e3]) expect(`${e.message} ${e.detalles.join(' ')}`).not.toContain(marca);
    });
  });
});
