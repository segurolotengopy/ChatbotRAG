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
    expect(r.rechazados[0]?.motivo).toBe('campo_ausente');
  });

  it('los rechazados solo llevan índice y motivo, nunca contenido', () => {
    const r = separarRegistrosHabilitados([{ secreto: 'DATO-SENSIBLE', habilitado_produccion: false }]);
    expect(JSON.stringify(r.rechazados)).not.toContain('DATO-SENSIBLE');
    expect(Object.keys(r.rechazados[0] ?? {}).sort()).toEqual(['indice', 'motivo']);
  });
});
