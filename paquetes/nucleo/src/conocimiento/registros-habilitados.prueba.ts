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
      sin_marca_no_validado: 0,
      version_invalida: 0,
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

describe('perfiles produccion y pruebas', () => {
  const nv = (extra: Record<string, unknown> = {}) => ({ id: 'x', habilitado_produccion: false, validacion: 'no_validado', version_paquete: '1.0.0', ...extra });

  // RED-LINE: el perfil de producción jamás deja entrar un registro no habilitado, tenga la marca que tenga.
  describe('red-line: produccion', () => {
    const intrusos: [string, unknown][] = [
      ['false con marca no_validado y versión', nv()],
      ['false con marca y sin versión', nv({ version_paquete: undefined })],
      ['false sin marca', { habilitado_produccion: false }],
      ['«true» texto con marca', nv({ habilitado_produccion: 'true' })],
      ['1 con marca', nv({ habilitado_produccion: 1 })],
      ['null con marca', nv({ habilitado_produccion: null })],
      ['ausente con marca', { validacion: 'no_validado', version_paquete: '1.0.0' }],
    ];
    it.each(intrusos)('no entra: %s', (_n, registro) => {
      const r = separarRegistrosHabilitados([registro]);
      expect(r.perfil).toBe('produccion');
      expect(r.habilitados).toHaveLength(0);
      expect(r.conteo).toMatchObject({ habilitados: 0, aceptados: 0, rechazados: 1 });
      expect(r.conteo.porEstado.no_validado).toBe(0);
      expect(JSON.stringify(r.habilitados)).not.toContain('no_validado');
    });
    it('explícito y por omisión dan lo mismo, y de una mezcla solo salen los true', () => {
      const mezcla = [nv(), { id: 'ok', habilitado_produccion: true }, nv({ version_paquete: 'x' }), { id: 'b', habilitado_produccion: false }];
      const a = separarRegistrosHabilitados(mezcla);
      const b = separarRegistrosHabilitados(mezcla, 'produccion');
      expect(a).toEqual(b);
      expect(a.habilitados).toEqual([{ id: 'ok', habilitado_produccion: true }]);
      expect('aceptados' in a).toBe(false);
    });
  });

  describe('pruebas', () => {
    it('acepta false con marca exacta y versión X.Y.Z, con su estado visible, y los true con estado habilitado', () => {
      const r = separarRegistrosHabilitados([nv(), { id: 'ok', habilitado_produccion: true }, nv({ version_paquete: '12.0.345' })], 'pruebas');
      expect(r.perfil).toBe('pruebas');
      expect(r.aceptados.map((a) => a.estado)).toEqual(['no_validado', 'habilitado', 'no_validado']);
      const primero = r.aceptados[0]!;
      expect(primero.estado === 'no_validado' && primero.version_paquete).toBe('1.0.0');
      expect(r.conteo).toMatchObject({ total: 3, habilitados: 1, aceptados: 3, rechazados: 0, porEstado: { habilitado: 1, no_validado: 2 } });
      expect('habilitados' in r).toBe(false);
    });

    it.each([
      ['sin marca', { habilitado_produccion: false, version_paquete: '1.0.0' }, 'sin_marca_no_validado'],
      ['marca distinta', nv({ validacion: 'validado' }), 'sin_marca_no_validado'],
      ['marca con otra capitalización', nv({ validacion: 'NO_VALIDADO' }), 'sin_marca_no_validado'],
      ['marca con espacio', nv({ validacion: 'no_validado ' }), 'sin_marca_no_validado'],
      ['marca no texto', nv({ validacion: true }), 'sin_marca_no_validado'],
      ['sin versión', nv({ version_paquete: undefined }), 'version_invalida'],
      ['versión sin patch', nv({ version_paquete: '1.0' }), 'version_invalida'],
      ['versión con prefijo', nv({ version_paquete: 'v1.0.0' }), 'version_invalida'],
      ['versión con salto de línea', nv({ version_paquete: '1.0.0\n' }), 'version_invalida'],
      ['versión numérica', nv({ version_paquete: 1 }), 'version_invalida'],
      ['habilitado texto', nv({ habilitado_produccion: 'false' }), 'valor_no_booleano'],
      ['habilitado null', nv({ habilitado_produccion: null }), 'valor_no_booleano'],
      ['habilitado ausente', { validacion: 'no_validado', version_paquete: '1.0.0' }, 'campo_ausente'],
      ['registro no objeto', 'texto', 'registro_invalido'],
    ])('rechaza %s con el motivo %#', (_n, registro, motivo) => {
      const r = separarRegistrosHabilitados([registro], 'pruebas');
      expect(r.aceptados).toHaveLength(0);
      expect(r.rechazados).toEqual([{ indice: 0, motivo }]);
    });

    it('la marca y la versión leídas por getter no cuentan', () => {
      const g = { habilitado_produccion: false } as Record<string, unknown>;
      Object.defineProperty(g, 'validacion', { get: () => 'no_validado', enumerable: true });
      Object.defineProperty(g, 'version_paquete', { get: () => '1.0.0', enumerable: true });
      expect(separarRegistrosHabilitados([g], 'pruebas').rechazados[0]?.motivo).toBe('sin_marca_no_validado');
      const h = { habilitado_produccion: false, validacion: 'no_validado' } as Record<string, unknown>;
      Object.defineProperty(h, 'version_paquete', { get: () => '1.0.0', enumerable: true });
      expect(separarRegistrosHabilitados([h], 'pruebas').rechazados[0]?.motivo).toBe('version_invalida');
    });

    it('devuelve copias y la entrada que no es arreglo se rechaza', () => {
      const entrada = [nv({ t: 'a' })];
      const r = separarRegistrosHabilitados(entrada, 'pruebas');
      (entrada[0] as Record<string, unknown>)['t'] = 'MUTADO';
      expect(r.aceptados[0]?.registro['t']).toBe('a');
      expect(separarRegistrosHabilitados({ a: 1 }, 'pruebas').rechazados).toEqual([{ indice: -1, motivo: 'registro_invalido' }]);
    });
  });
});
