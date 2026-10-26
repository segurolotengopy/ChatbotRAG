import { describe, expect, it } from 'vitest';
import { separarRegistrosHabilitados } from './registros-habilitados.js';

// Oráculos literales e independientes de la implementación.
const NO_HABILITAN: [string, unknown][] = [
  ['false', false],
  ['«true» texto', 'true'],
  ['«TRUE» texto', 'TRUE'],
  ['1', 1],
  ['0', 0],
  ['«si»', 'si'],
  ['null', null],
  ['undefined', undefined],
  ['objeto vacío', {}],
  ['arreglo', [true]],
  ['arreglo vacío', []],
  ['cadena vacía', ''],
];

describe('separarRegistrosHabilitados', () => {
  it('habilita solo el booleano true exacto', () => {
    const r = separarRegistrosHabilitados([{ id: 'a', habilitado_produccion: true }]);
    expect(r.habilitados).toHaveLength(1);
    expect(r.conteo).toMatchObject({ total: 1, habilitados: 1, rechazados: 0 });
  });

  it.each(NO_HABILITAN)('no habilita %s', (_n, valor) => {
    const r = separarRegistrosHabilitados([{ habilitado_produccion: valor }]);
    expect(r.habilitados).toHaveLength(0);
    expect(r.rechazados).toHaveLength(1);
  });

  it('distingue los motivos', () => {
    const r = separarRegistrosHabilitados([
      { habilitado_produccion: false },
      { habilitado_produccion: 'true' },
      { habilitado_produccion: null },
      { otro: 1 },
      null,
      'texto',
      [[true]],
      7,
    ]);
    expect(r.rechazados).toEqual([
      { indice: 0, motivo: 'no_habilitado' },
      { indice: 1, motivo: 'valor_no_booleano' },
      { indice: 2, motivo: 'valor_no_booleano' },
      { indice: 3, motivo: 'campo_ausente' },
      { indice: 4, motivo: 'registro_invalido' },
      { indice: 5, motivo: 'registro_invalido' },
      { indice: 6, motivo: 'registro_invalido' },
      { indice: 7, motivo: 'registro_invalido' },
    ]);
    expect(r.conteo.porMotivo).toEqual({
      no_habilitado: 1,
      valor_no_booleano: 2,
      campo_ausente: 1,
      registro_invalido: 4,
    });
  });

  it('estado_validacion y aprobacion no habilitan', () => {
    const r = separarRegistrosHabilitados([
      { estado_validacion: 'validado', aprobacion: 'aprobado', habilitado_produccion: false },
      { estado_validacion: 'validado', aprobacion: true },
    ]);
    expect(r.habilitados).toHaveLength(0);
  });

  it.each([undefined, null, 'x', 5, {}, true])('entrada no arreglo (%s) se rechaza sin excepción', (entrada) => {
    const r = separarRegistrosHabilitados(entrada);
    expect(r.habilitados).toHaveLength(0);
    expect(r.rechazados).toEqual([{ indice: -1, motivo: 'registro_invalido' }]);
  });

  it('arreglo vacío no rechaza nada', () => {
    expect(separarRegistrosHabilitados([]).conteo.total).toBe(0);
  });

  it('un campo heredado del prototipo no habilita', () => {
    const r = separarRegistrosHabilitados([Object.create({ habilitado_produccion: true })]);
    expect(r.rechazados[0]?.motivo).toBe('registro_invalido');
  });

  it('los rechazados solo llevan índice y motivo, nunca contenido', () => {
    const r = separarRegistrosHabilitados([{ secreto: 'DATO-SENSIBLE', habilitado_produccion: false }]);
    expect(JSON.stringify(r.rechazados)).not.toContain('DATO-SENSIBLE');
    expect(Object.keys(r.rechazados[0] ?? {}).sort()).toEqual(['indice', 'motivo']);
  });

  it('un getter no habilita, aunque devuelva true', () => {
    let n = 0;
    const g = {};
    Object.defineProperty(g, 'habilitado_produccion', { get: () => n++ === 0, enumerable: true });
    const r = separarRegistrosHabilitados([g]);
    expect(r.habilitados).toHaveLength(0);
    expect(r.rechazados).toEqual([{ indice: 0, motivo: 'valor_no_booleano' }]);
  });

  it('rechaza Proxy, Date, Map, clases y Boolean objeto', () => {
    class Clase {
      habilitado_produccion = true;
    }
    const proxy = new Proxy({}, { has: () => true, getOwnPropertyDescriptor: () => ({ value: true, configurable: true, enumerable: true }), get: () => true });
    const r = separarRegistrosHabilitados([
      proxy,
      Object.assign(new Date(), { habilitado_produccion: true }),
      Object.assign(new Map(), { habilitado_produccion: true }),
      new Clase(),
      { habilitado_produccion: new Boolean(true) },
    ]);
    expect(r.habilitados).toHaveLength(0);
    expect(r.rechazados.map((x) => x.motivo)).toEqual([
      'registro_invalido', 'registro_invalido', 'registro_invalido', 'registro_invalido', 'valor_no_booleano',
    ]);
  });

  it('acepta objetos con prototipo null', () => {
    const o = Object.create(null) as Record<string, unknown>;
    o['habilitado_produccion'] = true;
    expect(separarRegistrosHabilitados([o]).habilitados).toHaveLength(1);
  });

  it('un arreglo Proxy se rechaza entero', () => {
    expect(separarRegistrosHabilitados(new Proxy([{ habilitado_produccion: true }], {})).conteo.habilitados).toBe(0);
  });

  it('los huecos de un arreglo disperso son registro_invalido', () => {
    // eslint-disable-next-line no-sparse-arrays
    const r = separarRegistrosHabilitados([, { habilitado_produccion: true }]);
    expect(r.rechazados).toEqual([{ indice: 0, motivo: 'registro_invalido' }]);
    expect(r.conteo).toMatchObject({ total: 2, habilitados: 1, rechazados: 1 });
  });

  it('__proto__ de JSON no habilita y en clave duplicada gana la última', () => {
    expect(separarRegistrosHabilitados(JSON.parse('[{"__proto__":{"habilitado_produccion":true}}]')).habilitados).toHaveLength(0);
    expect(separarRegistrosHabilitados(JSON.parse('[{"habilitado_produccion":false,"habilitado_produccion":true}]')).habilitados).toHaveLength(1);
    expect(separarRegistrosHabilitados(JSON.parse('[{"habilitado_produccion":true,"habilitado_produccion":false}]')).habilitados).toHaveLength(0);
  });

  it('devuelve copias: mutar la entrada después no altera los habilitados', () => {
    const entrada = [{ habilitado_produccion: true, t: 'a', anidado: { x: 1 } }];
    const r = separarRegistrosHabilitados(entrada);
    entrada[0]!.t = 'MUTADO';
    entrada[0]!.anidado.x = 99;
    expect(r.habilitados[0]).toEqual({ habilitado_produccion: true, t: 'a', anidado: { x: 1 } });
  });
});
