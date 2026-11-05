/** Pruebas de la medición y elección de umbrales. Vectores a mano (2 dimensiones), sin embeddings. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MINIMO_NINGUNA, MINIMO_POR_ENTRADA, barrerUmbrales, elegirUmbral, medir, verificarMinimos } from './medir.js';
import type { CasoMedible, Minimos } from './medir.js';
import { ErrorSimilitud } from './similitud.js';
import type { IndiceSemantico } from './similitud.js';

const angulo = (grados: number): number[] => [Math.cos((grados * Math.PI) / 180), Math.sin((grados * Math.PI) / 180)];
const INDICE: IndiceSemantico = {
  modelo: 'prueba',
  dimension: 2,
  vectores: [
    { entradaId: 'a', tipo: 'respuesta', vector: angulo(0) },
    { entradaId: 'b', tipo: 'respuesta', vector: angulo(90) },
    { entradaId: 'd', tipo: 'derivacion', vector: angulo(180) },
  ],
};
const U = { umbralFijo: 0.9, umbralDerivacion: 0.8, margen: 0.1 };
const caso = (id: string, grados: number, esperado: CasoMedible['esperado'], particion: CasoMedible['particion'] = 'calibracion'): CasoMedible => ({
  id,
  vector: angulo(grados),
  esperado,
  particion,
});
const resp = (entradaId: string) => ({ tipo: 'respuesta' as const, entradaId });
const der = (entradaId: string) => ({ tipo: 'derivacion' as const, entradaId });
const NINGUNA = { tipo: 'ninguna' as const };
const BIEN = { minimoPorEntrada: 5, casosNinguna: 30, cumple: true };
const MAL = { minimoPorEntrada: 4, casosNinguna: 30, cumple: false };
const CUMPLE: Minimos = { calibracion: BIEN, control: BIEN, cumple: true };

describe('puntajes no finitos', () => {
  it('calibrar con un vector no finito falla de forma ruidosa, nunca con NaN en silencio', () => {
    const indice: IndiceSemantico = { modelo: 'prueba', dimension: 2, vectores: [{ entradaId: 'a', tipo: 'respuesta', vector: [1, 0] }] };
    const casos = [{ id: 'c1', vector: [Number.NaN, 1], esperado: { tipo: 'ninguna' as const }, particion: 'calibracion' as const }];
    expect(() => barrerUmbrales(casos, indice, { margen: 0.1 })).toThrow(ErrorSimilitud);
    expect(() => medir(casos, indice, { umbralFijo: 0.9, umbralDerivacion: 0.9, margen: 0.1 })).toThrow(ErrorSimilitud);
  });
});

describe('medir', () => {
  it('cuenta la matriz conocida', () => {
    const casos = [
      caso('1', 5, resp('a')), // acierto
      caso('2', 85, resp('b')), // acierto
      caso('3', 175, der('d')), // acierto (derivación)
      caso('4', 2, resp('b')), // confusión: se esperaba b y se propuso a
      caso('5', 3, der('d')), // confusión entre tipos: se propuso a
      caso('6', 1, NINGUNA), // falso positivo: se propuso a
      caso('7', 45, NINGUNA), // acierto: empate a/b, margen cero, nada propuesto
      caso('8', 45, resp('a')), // falso negativo: debía responder y fue a la IA
    ];
    const c = medir(casos, INDICE, U);
    expect(c).toEqual({
      total: 8,
      aciertos: 4,
      confusiones: 2,
      falsosPositivos: 1,
      falsosNegativos: 1,
      casosConEntrada: 6,
      casosNinguna: 2,
      cobertura: 3 / 6,
    });
  });

  it('sin casos todo es cero', () => {
    expect(medir([], INDICE, U)).toEqual({ total: 0, aciertos: 0, confusiones: 0, falsosPositivos: 0, falsosNegativos: 0, casosConEntrada: 0, casosNinguna: 0, cobertura: 0 });
  });

  it('no muta los casos ni el índice', () => {
    const casos = [caso('1', 5, resp('a'))];
    const antes = JSON.stringify([casos, INDICE]);
    medir(casos, INDICE, U);
    expect(JSON.stringify([casos, INDICE])).toBe(antes);
  });
});

describe('barrerUmbrales', () => {
  const casos = [caso('1', 10, resp('a')), caso('2', 10, resp('a'), 'control')];

  it('recorre de 0,50 a 0,99 en pasos de 0,01 y separa las particiones', () => {
    const filas = barrerUmbrales(casos, INDICE, { margen: 0.1 });
    expect(filas).toHaveLength(50);
    expect(filas[0]?.umbralFijo).toBe(0.5);
    expect(filas[49]?.umbralFijo).toBe(0.99);
    expect(filas.map((f) => f.umbralFijo)).toEqual(Array.from({ length: 50 }, (_, i) => (50 + i) / 100));
    expect(filas[0]?.calibracion.total).toBe(1);
    expect(filas[0]?.control.total).toBe(1);
    // cos 10° = 0,9848: se acierta hasta 0,98 y desde 0,99 pasa a falso negativo.
    expect(filas.find((f) => f.umbralFijo === 0.98)?.calibracion.aciertos).toBe(1);
    expect(filas.find((f) => f.umbralFijo === 0.99)?.calibracion.falsosNegativos).toBe(1);
  });

  it('la derivación puede exigir menos con diferenciaDerivacion', () => {
    const filas = barrerUmbrales(casos, INDICE, { margen: 0.1, diferenciaDerivacion: 0.1 });
    expect(filas[0]?.umbralDerivacion).toBe(0.4);
    expect(filas.find((f) => f.umbralFijo === 0.8)?.umbralDerivacion).toBe(0.7);
    const sinDif = barrerUmbrales(casos, INDICE, { margen: 0.1 });
    expect(sinDif.every((f) => f.umbralDerivacion === f.umbralFijo)).toBe(true);
  });

  it('coincide con medir() fila por fila', () => {
    const mezcla = [caso('1', 20, resp('b')), caso('2', 30, NINGUNA), caso('3', 10, resp('a'), 'control')];
    for (const f of barrerUmbrales(mezcla, INDICE, { margen: 0.1, diferenciaDerivacion: 0.05 })) {
      const u = { umbralFijo: f.umbralFijo, umbralDerivacion: f.umbralDerivacion, margen: f.margen };
      expect(f.calibracion).toEqual(medir(mezcla.filter((c) => c.particion === 'calibracion'), INDICE, u));
      expect(f.control).toEqual(medir(mezcla.filter((c) => c.particion === 'control'), INDICE, u));
    }
  });
});

describe('barrerUmbrales: validación', () => {
  it('rechaza margen y diferenciaDerivacion inválidos, también con casos vacíos', () => {
    for (const margen of [Number.NaN, -0.1, 1.1, Infinity]) expect(() => barrerUmbrales([], INDICE, { margen })).toThrow(ErrorSimilitud);
    for (const diferenciaDerivacion of [Number.NaN, -0.01, Infinity]) {
      expect(() => barrerUmbrales([], INDICE, { margen: 0.1, diferenciaDerivacion })).toThrow(ErrorSimilitud);
    }
    expect(barrerUmbrales([], INDICE, { margen: 0.1, diferenciaDerivacion: 0 })).toHaveLength(50);
  });
});

describe('elegirUmbral', () => {
  const calibracion = [
    caso('c1', 10, resp('a')),
    caso('c2', 80, resp('b')),
    caso('c3', 30, NINGUNA), // falso positivo mientras el umbral sea <= 0,86
    caso('c4', 20, resp('b')), // confusión (puntaje 0,9397 contra a) mientras el umbral sea <= 0,93
  ];

  it('toma el MENOR umbral sin confusiones ni falsos positivos en calibración', () => {
    const filas = barrerUmbrales(calibracion, INDICE, { margen: 0.1 });
    const r = elegirUmbral(filas, CUMPLE);
    expect(r?.umbralFijo).toBe(0.94);
    expect(r?.calibracion.confusiones).toBe(0);
    expect(r?.calibracion.falsosPositivos).toBe(0);
    expect(r?.calibracion.falsosNegativos).toBe(1);
    expect(r?.margen).toBe(0.1);
    expect(r?.valido).toBe(true);
    expect(r?.motivosInvalidez).toEqual([]);
  });

  it('sin umbral factible devuelve null, nunca un valor por defecto', () => {
    const imposible = [caso('x', 0, resp('b'))]; // coincide con a a la perfección: confusión hasta 0,99
    expect(elegirUmbral(barrerUmbrales(imposible, INDICE, { margen: 0.1 }), CUMPLE)).toBeNull();
    expect(elegirUmbral([], CUMPLE)).toBeNull();
  });

  it('una confusión en el control invalida la calibración', () => {
    const casos = [...calibracion, caso('k1', 15, resp('b'), 'control')]; // puntaje 0,9659 contra a
    const r = elegirUmbral(barrerUmbrales(casos, INDICE, { margen: 0.1 }), CUMPLE);
    expect(r?.umbralFijo).toBe(0.94);
    expect(r?.control.confusiones).toBe(1);
    expect(r?.valido).toBe(false);
    expect(r?.motivosInvalidez).toEqual(['confusion_en_control']);
  });

  it('sin los mínimos de D8 la calibración es inválida aunque el control esté limpio', () => {
    const r = elegirUmbral(barrerUmbrales(calibracion, INDICE, { margen: 0.1 }), { calibracion: BIEN, control: MAL, cumple: false });
    expect(r?.valido).toBe(false);
    expect(r?.motivosInvalidez).toEqual(['minimos_insuficientes']);
  });

  it('un falso positivo «ninguna» en el control invalida la calibración', () => {
    // Un caso «ninguna» a 18° de a (puntaje 0,951) sobrevive al umbral elegido (0,94) y se cuenta como falso positivo.
    const casosFp = [...calibracion, caso('k2', 18, NINGUNA, 'control')];
    const r = elegirUmbral(barrerUmbrales(casosFp, INDICE, { margen: 0.1 }), CUMPLE);
    expect(r?.umbralFijo).toBe(0.94);
    expect(r?.control.falsosPositivos).toBe(1);
    expect(r?.valido).toBe(false);
    expect(r?.motivosInvalidez).toEqual(['falso_positivo_en_control']);
  });

  it('calibración vacía o sin «ninguna»: null, nunca el piso del barrido', () => {
    // Todo en control: la calibración está vacía, así que 0,50 daría «sin errores» por falta de datos.
    const todoControl = [caso('x', 30, NINGUNA, 'control'), caso('y', 10, resp('a'), 'control')];
    const filas = barrerUmbrales(todoControl, INDICE, { margen: 0.1 });
    expect(filas[0]?.calibracion.total).toBe(0);
    expect(elegirUmbral(filas, verificarMinimos(todoControl, INDICE))).toBeNull();
    // Calibración con entradas pero sin «ninguna», y todos los «ninguna» en control.
    const sinNinguna = [...calibracion.filter((c) => c.esperado.tipo !== 'ninguna'), ...Array.from({ length: 40 }, (_, i) => caso(`n${i}`, 30, NINGUNA, 'control'))];
    const m = verificarMinimos(sinNinguna, INDICE);
    expect(m.calibracion.casosNinguna).toBe(0);
    expect(elegirUmbral(barrerUmbrales(sinNinguna, INDICE, { margen: 0.1 }), m)).toBeNull();
    expect(elegirUmbral(barrerUmbrales([], INDICE, { margen: 0.1 }), verificarMinimos([], INDICE))).toBeNull();
  });

  it('con la regla B una respuesta líder bajo su umbral cede ante la derivación casi empatada', () => {
    const indiceB: IndiceSemantico = {
      modelo: 'prueba',
      dimension: 2,
      vectores: [
        { entradaId: 'a', tipo: 'respuesta', vector: angulo(0) },
        { entradaId: 'd', tipo: 'derivacion', vector: angulo(60) },
      ],
    };
    // Consulta a 25°: respuesta 0,906 (líder) y derivación 0,819, a 0,087 de distancia.
    const c = [caso('d1', 25, der('d'))];
    expect(medir(c, indiceB, { umbralFijo: 0.95, umbralDerivacion: 0.7, margen: 0.1 }).aciertos).toBe(1);
    // Si la respuesta alcanza su umbral, se propone la respuesta y el caso esperado «d» es una confusión.
    expect(medir(c, indiceB, { umbralFijo: 0.9, umbralDerivacion: 0.7, margen: 0.05 }).confusiones).toBe(1);
  });

  it('informa ambos motivos a la vez', () => {
    const casos = [...calibracion, caso('k1', 15, resp('b'), 'control')];
    const r = elegirUmbral(barrerUmbrales(casos, INDICE, { margen: 0.1 }), { calibracion: BIEN, control: MAL, cumple: false });
    expect(r?.motivosInvalidez).toEqual(['confusion_en_control', 'minimos_insuficientes']);
  });
});

describe('verificarMinimos', () => {
  const generar = (porEntrada: number, ninguna: number, particiones: CasoMedible['particion'][] = ['calibracion', 'control']) => {
    const casos: Array<Pick<CasoMedible, 'esperado' | 'particion'>> = [];
    for (const particion of particiones) {
      for (const id of ['a', 'b']) for (let i = 0; i < porEntrada; i++) casos.push({ esperado: resp(id), particion });
      for (let i = 0; i < porEntrada; i++) casos.push({ esperado: der('d'), particion });
      for (let i = 0; i < ninguna; i++) casos.push({ esperado: NINGUNA, particion });
    }
    return casos;
  };

  it('exige 5 casos por entrada y 30 «ninguna» en CADA partición', () => {
    expect(MINIMO_POR_ENTRADA).toBe(5);
    expect(MINIMO_NINGUNA).toBe(30);
    expect(verificarMinimos(generar(5, 30), INDICE)).toEqual({ calibracion: BIEN, control: BIEN, cumple: true });
    expect(verificarMinimos(generar(4, 30), INDICE).cumple).toBe(false);
    expect(verificarMinimos(generar(5, 29), INDICE).cumple).toBe(false);
  });

  it('una partición completa no compensa a la otra', () => {
    const soloControl = verificarMinimos(generar(5, 30, ['control']), INDICE);
    expect(soloControl.control.cumple).toBe(true);
    expect(soloControl.calibracion).toEqual({ minimoPorEntrada: 0, casosNinguna: 0, cumple: false });
    expect(soloControl.cumple).toBe(false);
    // 30 «ninguna» sumados entre ambas particiones (15 + 15) no alcanzan.
    const repartidos = [...generar(5, 15)];
    expect(verificarMinimos(repartidos, INDICE).cumple).toBe(false);
  });

  it('una entrada sin casos en una partición baja su mínimo a 0', () => {
    const casos = generar(5, 30).filter((c) => !(c.particion === 'control' && c.esperado.entradaId === 'a'));
    const m = verificarMinimos(casos, INDICE);
    expect(m.control.minimoPorEntrada).toBe(0);
    expect(m.calibracion.cumple).toBe(true);
  });

  it('un índice vacío no cumple', () => {
    expect(verificarMinimos(generar(5, 30), { modelo: 'x', dimension: 2, vectores: [] }).cumple).toBe(false);
  });
});

describe('estructura', () => {
  it('el archivo no usa red, entorno ni expresiones construidas', () => {
    const fuente = readFileSync(new URL('./medir.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Date', 'Math.random']) expect(fuente).not.toContain(prohibido);
  });
});
