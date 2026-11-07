/** Pruebas del emparejamiento semántico. Vectores a mano; sin embeddings reales. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Embebedor } from '../puertos/proveedor-llm.js';
import { EmbebedorSimulado } from '../proveedores/simulado.js';
import { cargarBanco } from './cargar.js';
import { ErrorSimilitud, coseno, decidirEmparejamiento, emparejarSemantico, prepararIndiceSemantico } from './similitud.js';
import type { IndiceSemantico, UmbralesSemanticos } from './similitud.js';

const EJEMPLO = readFileSync(new URL('./banco-ejemplo.json', import.meta.url), 'utf8');
const BANCO = cargarBanco(EJEMPLO, { admitirSintetico: true }).banco;

const U: UmbralesSemanticos = { umbralFijo: 0.8, umbralDerivacion: 0.7, margen: 0.1 };
const indice = (vectores: IndiceSemantico['vectores']): IndiceSemantico => ({ modelo: 'prueba', dimension: 2, vectores });
/** Vector unitario con el ángulo dado: el coseno contra [1, 0] es cos(grados). */
const angulo = (grados: number): number[] => [Math.cos((grados * Math.PI) / 180), Math.sin((grados * Math.PI) / 180)];

describe('coseno', () => {
  it('ortogonal, idéntico y opuesto', () => {
    expect(coseno([1, 0], [0, 1])).toBeCloseTo(0, 12);
    expect(coseno([3, 4], [3, 4])).toBeCloseTo(1, 12);
    expect(coseno([3, 4], [-3, -4])).toBeCloseTo(-1, 12);
    expect(coseno([1, 0], [5, 0])).toBe(1);
  });
  it('vector nulo vale 0', () => {
    expect(coseno([0, 0], [1, 1])).toBe(0);
    expect(coseno([1, 1], [0, 0])).toBe(0);
  });
  it('magnitudes enormes (> 1e154) no dan NaN ni 0: se escala cada vector y el coseno es el correcto', () => {
    expect(coseno([1e200, 1e200], [1e200, 1e199])).toBeCloseTo(1.1 / (Math.SQRT2 * Math.sqrt(1.01)), 12);
    expect(coseno([1e200, 0], [1, 0])).toBe(1);
    expect(coseno([1e200, 0], [-1e300, 0])).toBe(-1);
    expect(coseno([1e200, 1e200], [1e-200, 1e-200])).toBeCloseTo(1, 12);
    expect(coseno([1e150, 1e150], [1e150, 1e150])).toBeCloseTo(1, 12);
    expect(coseno([Number.MAX_VALUE, Number.MAX_VALUE], [Number.MAX_VALUE, 0])).toBeCloseTo(Math.SQRT1_2, 12);
  });

  it('magnitudes diminutas (cuadrados que se pierden o son subnormales) no se confunden con un vector nulo', () => {
    expect(coseno([1e-200, 0], [1, 0])).toBe(1);
    expect(coseno([1e-200, 1e-200], [1e-200, 0])).toBeCloseTo(Math.SQRT1_2, 12);
    expect(coseno([5e-324, 0], [1, 0])).toBe(1); // subnormal mínimo
    expect(coseno([1e-310, 1e-310], [1e-310, -1e-310])).toBeCloseTo(0, 12);
    expect(coseno([1e-160, 3e-160], [3e-160, 1e-160])).toBeCloseTo(0.6, 12);
  });

  it('un vector con todo en cero sigue valiendo 0, también frente a uno enorme o diminuto', () => {
    expect(coseno([0, 0], [1e200, 1])).toBe(0);
    expect(coseno([1e-200, 0], [0, 0])).toBe(0);
  });

  it('el rango normal no cambia (mismo resultado que la fórmula directa)', () => {
    const a = [0.3, -0.4, 0.5];
    const b = [0.1, 0.2, 0.9];
    const directo = (0.3 * 0.1 - 0.4 * 0.2 + 0.5 * 0.9) / (Math.sqrt(0.09 + 0.16 + 0.25) * Math.sqrt(0.01 + 0.04 + 0.81));
    expect(coseno(a, b)).toBe(directo);
  });

  it('largo distinto, vacío o no finito lanzan error claro', () => {
    expect(() => coseno([1, 0], [1, 0, 0])).toThrow(ErrorSimilitud);
    expect(() => coseno([], [])).toThrow(ErrorSimilitud);
    expect(() => coseno([Number.NaN, 1], [1, 1])).toThrow(ErrorSimilitud);
    expect(() => coseno([1, Infinity], [1, 1])).toThrow(ErrorSimilitud);
  });
});

describe('emparejarSemantico', () => {
  const base = indice([
    { entradaId: 'r-uno', tipo: 'respuesta', vector: [1, 0] },
    { entradaId: 'r-dos', tipo: 'respuesta', vector: [0, 1] },
    { entradaId: 'd-uno', tipo: 'derivacion', vector: angulo(180) },
  ]);

  it('propone la entrada cuando supera el umbral y el margen', () => {
    const r = emparejarSemantico([1, 0], base, U);
    expect(r).toMatchObject({ tipo: 'respuesta', entradaId: 'r-uno' });
    expect(r?.puntaje).toBeCloseTo(1, 12);
    expect(r?.margen).toBeCloseTo(1, 12);
  });

  it('el umbral exacto cuenta y un poco por debajo no', () => {
    const exacto = indice([{ entradaId: 'r-uno', tipo: 'respuesta', vector: [1, 0] }]);
    // Vector con coseno exactamente 0.8 contra [1, 0]: [0.8, 0.6].
    expect(emparejarSemantico([0.8, 0.6], exacto, { ...U, umbralFijo: 0.8 })?.entradaId).toBe('r-uno');
    expect(emparejarSemantico([0.8, 0.6], exacto, { ...U, umbralFijo: 0.81 })).toBeNull();
  });

  it('cada tipo usa su propio umbral', () => {
    const d = indice([{ entradaId: 'd-uno', tipo: 'derivacion', vector: [1, 0] }]);
    const r = indice([{ entradaId: 'r-uno', tipo: 'respuesta', vector: [1, 0] }]);
    const consulta = [0.75, Math.sqrt(1 - 0.75 * 0.75)];
    expect(emparejarSemantico(consulta, d, U)?.tipo).toBe('derivacion');
    expect(emparejarSemantico(consulta, r, U)).toBeNull();
  });

  it('margen insuficiente contra otra entrada da null', () => {
    const cerca = indice([
      { entradaId: 'r-uno', tipo: 'respuesta', vector: angulo(0) },
      { entradaId: 'r-dos', tipo: 'respuesta', vector: angulo(10) },
    ]);
    expect(emparejarSemantico(angulo(2), cerca, U)).toBeNull();
    expect(emparejarSemantico(angulo(2), cerca, { ...U, margen: 0 })?.entradaId).toBe('r-uno');
  });

  it('otra pregunta de la misma entrada no cuenta como competencia', () => {
    const misma = indice([
      { entradaId: 'r-uno', tipo: 'respuesta', vector: angulo(0) },
      { entradaId: 'r-uno', tipo: 'respuesta', vector: angulo(5) },
    ]);
    const r = emparejarSemantico(angulo(2), misma, U);
    expect(r?.entradaId).toBe('r-uno');
    expect(r?.margen).toBeCloseTo(Math.cos((2 * Math.PI) / 180), 12);
  });

  it('el empate entre derivación y respuesta lo gana la derivación', () => {
    const empate = indice([
      { entradaId: 'r-uno', tipo: 'respuesta', vector: [1, 0] },
      { entradaId: 'd-uno', tipo: 'derivacion', vector: [1, 0] },
    ]);
    expect(emparejarSemantico([1, 0], empate, { ...U, margen: 0 })).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
    // Regla B monótona (H4a): con margen mayor que cero, el empate con una respuesta también deriva (antes iba a la IA).
    expect(emparejarSemantico([1, 0], empate, U)).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
  });

  it('regla B: una respuesta bajo su umbral cede ante una derivación casi empatada que supera el suyo', () => {
    const b = indice([
      { entradaId: 'r-uno', tipo: 'respuesta', vector: angulo(0) },
      { entradaId: 'd-uno', tipo: 'derivacion', vector: angulo(60) },
    ]);
    const u = { umbralFijo: 0.95, umbralDerivacion: 0.7, margen: 0.1 };
    // La respuesta puntúa 0,906 (mejor, pero bajo 0,95) y la derivación 0,819 (sobre 0,7, a 0,087 de la líder): deriva.
    const r = emparejarSemantico(angulo(25), b, u);
    expect(r).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
    expect(r?.puntaje).toBeCloseTo(Math.cos((35 * Math.PI) / 180), 12);
    // Sin otra entrada, el margen es la distancia a la respuesta líder, no el puntaje.
    expect(r?.margen).toBeCloseTo(Math.cos((25 * Math.PI) / 180) - Math.cos((35 * Math.PI) / 180), 12);
    // Si la derivación tampoco alcanza su umbral, va a la IA.
    expect(emparejarSemantico(angulo(25), b, { ...u, umbralDerivacion: 0.85 })).toBeNull();
    // Si la respuesta sí alcanza su umbral, sigue ganando la respuesta (con margen suficiente contra la derivación).
    expect(emparejarSemantico(angulo(25), b, { ...u, umbralFijo: 0.9, margen: 0.05 })?.tipo).toBe('respuesta');
  });

  it('regla B: la derivación debe distanciarse de las demás entradas, excluyendo solo a la líder', () => {
    const base = [
      { entradaId: 'r-uno', tipo: 'respuesta' as const, vector: angulo(0) },
      { entradaId: 'd-uno', tipo: 'derivacion' as const, vector: angulo(55) },
    ];
    const u = { umbralFijo: 0.95, umbralDerivacion: 0.7, margen: 0.05 };
    const cerca = indice([...base, { entradaId: 'd-dos', tipo: 'derivacion', vector: angulo(56) }]);
    expect(emparejarSemantico(angulo(25), cerca, u)).toBeNull();
    expect(emparejarSemantico(angulo(25), cerca, { ...u, margen: 0 })).toBeNull(); // líder a 0,04 > margen 0
    const lejos = indice([...base, { entradaId: 'd-dos', tipo: 'derivacion', vector: angulo(80) }]);
    const r = emparejarSemantico(angulo(25), lejos, u);
    expect(r?.entradaId).toBe('d-uno');
    // Margen real: distancia a la siguiente mejor entrada distinta (d-dos), no al puntaje ni a la líder.
    expect(r?.margen).toBeCloseTo(Math.cos((30 * Math.PI) / 180) - Math.cos((55 * Math.PI) / 180), 12);
    // Otra respuesta casi empatada con la candidata no compite: también cede (regla B monótona).
    const otraRespuesta = indice([...base, { entradaId: 'r-dos', tipo: 'respuesta', vector: angulo(52) }]);
    expect(emparejarSemantico(angulo(25), otraRespuesta, u)?.entradaId).toBe('d-uno');
    // Una respuesta claramente por encima de la candidata (más allá del margen) no es empate: decide la regla común
    // y se propone esa respuesta (antes de este ajuste una respuesta débil empatada con una derivación mediocre
    // la tapaba y el mensaje iba a la IA).
    const porEncima = indice([...base, { entradaId: 'r-dos', tipo: 'respuesta', vector: angulo(25) }]);
    expect(emparejarSemantico(angulo(25), porEncima, u)).toMatchObject({ tipo: 'respuesta', entradaId: 'r-dos' });
  });

  describe('regla B con puntajes exactos (umbralFijo 0,80, umbralDerivacion 0,70, margen 0,05)', () => {
    const u = { umbralFijo: 0.8, umbralDerivacion: 0.7, margen: 0.05 };
    /** Puntajes exactos contra la consulta [1, 0]: una respuesta y una derivación con esos cosenos. */
    const con = (respuesta: number, derivacion: number) =>
      emparejarSemantico([1, 0], indice([
        { entradaId: 'r-uno', tipo: 'respuesta', vector: [respuesta, Math.sqrt(1 - respuesta * respuesta)] },
        { entradaId: 'd-uno', tipo: 'derivacion', vector: [derivacion, -Math.sqrt(1 - derivacion * derivacion)] },
      ]), u);

    it('respuesta 0,79 y derivación 0,78: casi empatadas, deriva', () => {
      expect(con(0.79, 0.78)).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
      expect(con(0.79, 0.78)?.margen).toBeCloseTo(0.01, 12);
    });
    it('respuesta 0,79 y derivación 0,71: la derivación está lejos de la líder, va a la IA', () => {
      expect(con(0.79, 0.71)).toBeNull();
    });
    it('respuesta 0,81 y derivación 0,79: la respuesta supera su umbral pero la derivación está casi empatada, deriva (monótona)', () => {
      expect(con(0.81, 0.79)).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
    });
    it('derivación líder con una respuesta bajo umbral como segunda: la respuesta no compite (0,79 con 0,79, 0,80 y 0,84)', () => {
      for (const d of [0.79, 0.8, 0.84, 0.85]) {
        const r = con(0.79, d);
        expect(r).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
      }
      // Margen devuelto: distancia a la respuesta excluida, que puede ser menor que el margen pedido.
      expect(con(0.79, 0.8)?.margen).toBeCloseTo(0.01, 12);
    });

    it('con una tercera entrada en 0,77 que sí compite (otra derivación), el margen insuficiente da nulo', () => {
      const vec = (c: number, signo = 1) => [c, signo * Math.sqrt(1 - c * c)];
      const tres = (d: number) =>
        emparejarSemantico([1, 0], indice([
          { entradaId: 'r-uno', tipo: 'respuesta', vector: vec(0.79) },
          { entradaId: 'd-uno', tipo: 'derivacion', vector: vec(d, -1) },
          { entradaId: 'd-dos', tipo: 'derivacion', vector: vec(0.77) },
        ]), u);
      expect(tres(0.8)).toBeNull();
      expect(tres(0.85)?.entradaId).toBe('d-uno');
    });

    describe('tabla de la regla B monótona (respuesta, derivación)', () => {
      const vec = (c: number, signo = 1) => [c, signo * Math.sqrt(1 - c * c)];
      /** Con una tercera entrada opcional: otra derivación en `tercera`. */
      const tabla = (r: number, d: number, tercera?: number) =>
        emparejarSemantico([1, 0], indice([
          { entradaId: 'r-uno', tipo: 'respuesta', vector: vec(r) },
          { entradaId: 'd-uno', tipo: 'derivacion', vector: vec(d, -1) },
          ...(tercera === undefined ? [] : [{ entradaId: 'd-dos', tipo: 'derivacion' as const, vector: vec(tercera) }]),
        ]), u);
      it.each([
        [0.79, 0.78],
        [0.79, 0.79],
        [0.79, 0.8],
        [0.79, 0.84],
        [0.81, 0.79],
      ])('respuesta %f y derivación %f derivan sin tercera entrada y con una tercera lejana', (r, d) => {
        expect(tabla(r, d)).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
        expect(tabla(r, d, 0.5)).toMatchObject({ tipo: 'derivacion', entradaId: 'd-uno' });
      });
      it('una tercera derivación cercana (0,77) da duda salvo que la candidata se distancie el margen', () => {
        expect(tabla(0.79, 0.78, 0.77)).toBeNull();
        expect(tabla(0.79, 0.79, 0.77)).toBeNull();
        expect(tabla(0.79, 0.8, 0.77)).toBeNull();
        expect(tabla(0.79, 0.84, 0.77)).toMatchObject({ entradaId: 'd-uno' });
        expect(tabla(0.81, 0.79, 0.77)).toBeNull();
      });
      it('monótona: toda respuesta a distancia de margen o menos de una derivación sobre su umbral deriva', () => {
        for (let r = 0.7; r <= 0.9 + 1e-9; r += 0.01) {
          const dist = Math.abs(r - 0.79);
          const res = tabla(Math.round(r * 100) / 100, 0.79);
          if (dist <= 0.05 + 1e-9) expect(res?.tipo, `r=${r.toFixed(2)}`).toBe('derivacion');
        }
      });
      it('una derivación bajo su umbral no deriva por estar empatada', () => {
        expect(tabla(0.69, 0.68)).toBeNull();
      });
    });

    it('bordes de coma flotante: una diferencia exactamente igual al margen cuenta', () => {
      // 0,79 - 0,74 = 0,05000000000000004 en coma flotante: sin tolerancia caería fuera del margen de la regla B.
      expect(con(0.79, 0.74)?.entradaId).toBe('d-uno');
      expect(con(0.79, 0.73)).toBeNull();
      // 0,84 - 0,79 = 0,04999999999999993: sin tolerancia la derivación no se distanciaría 0,05 de la otra derivación.
      const vec = (c: number, signo = 1) => [c, signo * Math.sqrt(1 - c * c)];
      const dos = emparejarSemantico([1, 0], indice([
        { entradaId: 'd-uno', tipo: 'derivacion', vector: vec(0.84) },
        { entradaId: 'd-dos', tipo: 'derivacion', vector: vec(0.79, -1) },
      ]), u);
      expect(dos?.entradaId).toBe('d-uno');
    });

    it('bordes de coma flotante: la derivación exactamente en umbralDerivacion cuenta en la regla B', () => {
      expect(con(0.72, 0.7)?.entradaId).toBe('d-uno');
      expect(con(0.72, 0.69)).toBeNull();
    });
  });

  it('el orden de las entradas no cambia el resultado', () => {
    const al_reves = indice([...base.vectores].reverse());
    expect(emparejarSemantico(angulo(20), base, { ...U, margen: 0 })).toEqual(emparejarSemantico(angulo(20), al_reves, { ...U, margen: 0 }));
  });

  it('un puntaje no finito (NaN, Infinity) no propone nada, aunque llegue a decidirEmparejamiento', () => {
    const u = { umbralFijo: 0.8, umbralDerivacion: 0.7, margen: 0.05 };
    for (const malo of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(decidirEmparejamiento([{ entradaId: 'r-uno', tipo: 'respuesta', puntaje: malo }], u)).toBeNull();
      expect(
        decidirEmparejamiento(
          [
            { entradaId: 'r-uno', tipo: 'respuesta', puntaje: 0.95 },
            { entradaId: 'd-uno', tipo: 'derivacion', puntaje: malo },
          ],
          u,
        ),
      ).toBeNull();
    }
  });

  describe('dos familias de la regla B fijadas como comportamiento actual (umbralFijo 0,80, umbralDerivacion 0,70, margen 0,05)', () => {
    // Pendiente de decisión de Andres: estas pruebas fijan lo que el código hace HOY, no lo que se considera ideal.
    const u = { umbralFijo: 0.8, umbralDerivacion: 0.7, margen: 0.05 };
    const v = (c: number, signo: number) => [c, signo * Math.sqrt(1 - c * c)];
    const con = (r0: number, r1: number, d: number) =>
      emparejarSemantico([1, 0], indice([
        { entradaId: 'r-cero', tipo: 'respuesta', vector: v(r0, 1) },
        { entradaId: 'r-uno', tipo: 'respuesta', vector: v(r1, -1) },
        { entradaId: 'd-uno', tipo: 'derivacion', vector: v(d, 1) },
      ]), u);

    it('r0 0,70, r1 0,80, d 0,70: la respuesta r1 está claramente por encima y se propone', () => {
      expect(con(0.7, 0.8, 0.7)).toMatchObject({ tipo: 'respuesta', entradaId: 'r-uno' });
    });
    it('r0 0,70, r1 0,76, d 0,70: la mejor respuesta no llega a su umbral, va a la IA', () => {
      expect(con(0.7, 0.76, 0.7)).toBeNull();
    });
    it('d 0,79, r0 0,80, r1 0,845: la respuesta r1 no se distancia de r0 por el margen, va a la IA', () => {
      expect(con(0.8, 0.845, 0.79)).toBeNull();
    });
  });

  it('índice vacío da null y umbrales inválidos lanzan error', () => {
    expect(emparejarSemantico([1, 0], indice([]), U)).toBeNull();
    expect(decidirEmparejamiento([], U)).toBeNull();
    expect(() => emparejarSemantico([1, 0], base, { ...U, umbralFijo: 0 })).toThrow(ErrorSimilitud);
    expect(() => emparejarSemantico([1, 0], base, { ...U, umbralDerivacion: 1.1 })).toThrow(ErrorSimilitud);
    expect(() => emparejarSemantico([1, 0], base, { ...U, margen: -0.1 })).toThrow(ErrorSimilitud);
  });

  it('con dimensión distinta lanza error', () => {
    expect(() => emparejarSemantico([1, 0, 0], base, U)).toThrow(ErrorSimilitud);
  });
});

describe('prepararIndiceSemantico', () => {
  it('usa la vía de indexación del embebedor si existe, y embeber si no', async () => {
    const vias: string[] = [];
    const conVia: Embebedor = {
      nombre: 'falso', dimension: 2,
      async embeber(t) { vias.push('consulta'); return t.map(() => [1, 0]); },
      async embeberParaIndexar(t) { vias.push('indexar'); return t.map(() => [1, 0]); },
    };
    await prepararIndiceSemantico(BANCO, conVia);
    expect(vias).toEqual(['indexar']);
    const sinVia: Embebedor = { nombre: 'falso', dimension: 2, async embeber(t) { vias.push('embeber'); return t.map(() => [1, 0]); } };
    await prepararIndiceSemantico(BANCO, sinVia);
    expect(vias).toEqual(['indexar', 'embeber']);
  });

  it('embebe las preguntas de respuestas y derivaciones, sin mutar el banco', async () => {
    const antes = JSON.stringify(BANCO);
    const emb = new EmbebedorSimulado(16);
    const idx = await prepararIndiceSemantico(BANCO, emb);
    expect(JSON.stringify(BANCO)).toBe(antes);
    expect(idx.modelo).toBe('simulado');
    expect(idx.dimension).toBe(16);
    // 2+1+1+1 preguntas de respuestas y 2 de la derivación de siniestro; la de emergencia solo tiene términos.
    expect(idx.vectores).toHaveLength(7);
    expect(idx.vectores.filter((v) => v.tipo === 'derivacion').map((v) => v.entradaId)).toEqual(['ejemplo-siniestro', 'ejemplo-siniestro']);
    expect(new Set(idx.vectores.map((v) => v.entradaId))).toEqual(new Set(['ejemplo-precio-1', 'ejemplo-precio-2', 'ejemplo-contacto', 'ejemplo-pendiente', 'ejemplo-siniestro']));
    expect(idx.vectores.every((v) => v.vector.length === 16)).toBe(true);
  });

  it('es determinista y una pregunta idéntica puntúa 1', async () => {
    const emb = new EmbebedorSimulado(32);
    const a = await prepararIndiceSemantico(BANCO, emb);
    const b = await prepararIndiceSemantico(BANCO, emb);
    expect(a).toEqual(b);
    const [v] = await emb.embeber(['pregunta sintetica de contacto']);
    const r = emparejarSemantico(v as number[], a, { umbralFijo: 0.9, umbralDerivacion: 0.9, margen: 0 });
    expect(r?.entradaId).toBe('ejemplo-contacto');
    expect(r?.puntaje).toBeCloseTo(1, 12);
  });

  it('un embebedor que devuelve de menos o con otra dimensión da error', async () => {
    const corto = { nombre: 'x', dimension: 4, embeber: async () => [[1, 0, 0, 0]] };
    await expect(prepararIndiceSemantico(BANCO, corto)).rejects.toThrow(ErrorSimilitud);
    const dim = { nombre: 'x', dimension: 4, embeber: async (t: string[]) => t.map(() => [1, 0]) };
    await expect(prepararIndiceSemantico(BANCO, dim)).rejects.toThrow(ErrorSimilitud);
  });

  it('un banco sin preguntas no llama al embebedor', async () => {
    const vacio = cargarBanco(JSON.stringify({ formato: 1, version: '1.0.0', respuestas: [] }), { admitirSintetico: true }).banco;
    const emb = { nombre: 'x', dimension: 4, embeber: async (): Promise<number[][]> => { throw new Error('no debía llamarse'); } };
    expect((await prepararIndiceSemantico(vacio, emb)).vectores).toEqual([]);
  });
});

describe('estructura', () => {
  it('el archivo no usa red, entorno ni expresiones construidas', () => {
    const fuente = readFileSync(new URL('./similitud.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Date', 'Math.random']) expect(fuente).not.toContain(prohibido);
  });
});
