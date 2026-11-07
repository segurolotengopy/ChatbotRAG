/**
 * Pruebas del tope, el reintento y el semáforo del embebedor de Vertex. Sin red: cliente falso, reloj y espera inyectados.
 * No prueban la cuota real de Vertex (supuesto sin verificar), solo que el código cumple lo que declara.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmbebedorVertex, MAX_TEXTOS_POR_LOTE, type ClienteGemini } from './indice.js';

const error = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });
type Embed = ClienteGemini['embedContent'];

function cliente(embed: Embed): ClienteGemini {
  return {
    async generateContent() {
      throw new Error('no se usa');
    },
    embedContent: embed,
  };
}
const ok: Embed = async (p) => ({ embeddings: p.contents.map((_, i) => ({ values: [i, 1, 0] })) });

afterEach(() => vi.useRealTimers());

describe('EmbebedorVertex: reintento del 429 y el 503', () => {
  it('reintenta tras un 429 y devuelve los vectores, con la espera esperada', async () => {
    let llamadas = 0;
    const esperas: number[] = [];
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        llamadas += 1;
        if (llamadas === 1) throw error(429);
        return ok(p);
      }),
      { esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0 },
    );
    expect(await e.embeber(['a', 'b'])).toEqual([[0, 1, 0], [1, 1, 0]]);
    expect(llamadas).toBe(2);
    expect(esperas).toEqual([400]);
  });

  it('la consulta reintenta una sola vez (el 503 también): el segundo 429 seguido sale con causa cuota', async () => {
    let llamadas = 0;
    const e = new EmbebedorVertex(cliente(async () => { llamadas += 1; throw error(llamadas === 1 ? 503 : 429); }), { esperar: async () => undefined, aleatorio: () => 0 });
    await expect(e.embeber(['a'])).rejects.toMatchObject({ causa: 'cuota' });
    expect(llamadas).toBe(2);
  });

  it('la indexación reintenta hasta 2 veces y usa la segunda espera en el segundo reintento', async () => {
    let llamadas = 0;
    const esperas: number[] = [];
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        llamadas += 1;
        if (llamadas <= 2) throw error(llamadas === 1 ? 503 : 429);
        return ok(p);
      }),
      { esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0.999 },
    );
    await e.embeberParaIndexar(['a']);
    expect(llamadas).toBe(3);
    expect(esperas).toEqual([Math.round(400 + 0.999 * 500), Math.round(1000 + 0.999 * 1000)]);
  });

  it('agotados los reintentos de la indexación lanza ErrorProveedor con causa cuota tras 3 llamadas', async () => {
    let llamadas = 0;
    const e = new EmbebedorVertex(cliente(async () => { llamadas += 1; throw error(429); }), { esperar: async () => undefined, aleatorio: () => 0 });
    await expect(e.embeberParaIndexar(['a'])).rejects.toMatchObject({ name: 'ErrorProveedor', causa: 'cuota' });
    expect(llamadas).toBe(3);
  });

  it('con reintentosCuota 0 no reintenta', async () => {
    let llamadas = 0;
    const e = new EmbebedorVertex(cliente(async () => { llamadas += 1; throw error(429); }), { reintentosCuota: 0 });
    await expect(e.embeber(['a'])).rejects.toMatchObject({ causa: 'cuota' });
    expect(llamadas).toBe(1);
  });

  it('no reintenta lo que no es cuota ni saturación (401, 404, 500, desconocido)', async () => {
    for (const [fallo, causa] of [[error(401), 'autenticacion'], [error(404), 'modelo'], [error(500), 'servidor'], [new Error('x'), 'otro']] as const) {
      let llamadas = 0;
      const e = new EmbebedorVertex(cliente(async () => { llamadas += 1; throw fallo; }), { esperar: async () => undefined });
      await expect(e.embeber(['a'])).rejects.toMatchObject({ causa });
      expect(llamadas).toBe(1);
    }
  });

  it('si el reintento no cabe en el presupuesto de la consulta, lanza sin esperar', async () => {
    let t = 0;
    let llamadas = 0;
    const esperas: number[] = [];
    const e = new EmbebedorVertex(
      cliente(async () => {
        llamadas += 1;
        t += 2000; // el intento consume 2 s del reloj inyectado
        throw error(429);
      }),
      { ahora: () => t, esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0 },
    );
    // 2000 + 400 + 2500 = 4900 > 4500: no cabe el reintento.
    await expect(e.embeber(['a'])).rejects.toMatchObject({ causa: 'cuota' });
    expect(llamadas).toBe(1);
    expect(esperas).toEqual([]);
  });

  it('con intento rápido el reintento de la consulta sí cabe en el presupuesto', async () => {
    let t = 0;
    let llamadas = 0;
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        llamadas += 1;
        t += 1000;
        if (llamadas === 1) throw error(429);
        return ok(p);
      }),
      { ahora: () => t, esperar: async () => undefined, aleatorio: () => 0 },
    );
    // 1000 + 400 + 2500 = 3900 ≤ 4500.
    await e.embeber(['a']);
    expect(llamadas).toBe(2);
  });

  it('el mensaje del error nombra el modelo y no la petición', async () => {
    const e = new EmbebedorVertex(cliente(async () => { throw error(401); }), { modelo: 'text-embedding-006' });
    await expect(e.embeber(['TEXTO-CENTINELA'])).rejects.not.toThrow(/CENTINELA/);
    await expect(e.embeber(['x'])).rejects.toThrow(/text-embedding-006/);
  });
});

describe('EmbebedorVertex: tope de tiempo por intento', () => {
  it('un intento colgado vence a los 2,5 s con causa tiempo y aborta la llamada', async () => {
    vi.useFakeTimers();
    let senal: AbortSignal | undefined;
    const e = new EmbebedorVertex(cliente((p) => { senal = p.config?.abortSignal; return new Promise(() => undefined); }));
    const r = e.embeber(['a']);
    const espera = expect(r).rejects.toMatchObject({ causa: 'tiempo' });
    await vi.advanceTimersByTimeAsync(2499);
    expect(senal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await espera;
    expect(senal?.aborted).toBe(true);
  });

  it('el tope es inyectable y el vencimiento no se reintenta', async () => {
    vi.useFakeTimers();
    let llamadas = 0;
    const e = new EmbebedorVertex(cliente(() => { llamadas += 1; return new Promise(() => undefined); }), { tiempoMaximoMs: 50 });
    const espera = expect(e.embeber(['a'])).rejects.toMatchObject({ causa: 'tiempo' });
    await vi.advanceTimersByTimeAsync(50);
    await espera;
    expect(llamadas).toBe(1);
  });

  it('rechaza opciones inválidas', () => {
    const c = cliente(ok);
    expect(() => new EmbebedorVertex(c, { tiempoMaximoMs: 0 })).toThrow(/tiempoMaximoMs/);
    expect(() => new EmbebedorVertex(c, { presupuestoMs: 0 })).toThrow(/presupuestoMs/);
    expect(() => new EmbebedorVertex(c, { reintentosCuota: 3 })).toThrow(/reintentosCuota/);
    expect(() => new EmbebedorVertex(c, { tiempoMaximoIndexacionMs: 0 })).toThrow(/tiempoMaximoIndexacionMs/);
    expect(() => new EmbebedorVertex(c, { presupuestoIndexacionMs: 0 })).toThrow(/presupuestoIndexacionMs/);
    expect(() => new EmbebedorVertex(c, { reintentosCuotaIndexacion: 3 })).toThrow(/reintentosCuotaIndexacion/);
    expect(() => new EmbebedorVertex(c, { maxConcurrentes: 0 })).toThrow(/maxConcurrentes/);
    expect(() => new EmbebedorVertex(c, { esperaMaxColaMs: 0 })).toThrow(/esperaMaxColaMs/);
  });
});

describe('EmbebedorVertex: semáforo propio', () => {
  it('con 1 cupo, la segunda llamada espera y la tercera, fuera de la cola de 2 s, falla con saturacion', async () => {
    vi.useFakeTimers();
    const liberar: Array<() => void> = [];
    const e = new EmbebedorVertex(cliente((p) => new Promise((r) => liberar.push(() => r({ embeddings: p.contents.map(() => ({ values: [1] })) })))), { maxConcurrentes: 1, esperaMaxColaMs: 2000, tiempoMaximoMs: 60_000, presupuestoMs: 120_000 });
    const a = e.embeber(['a']);
    await vi.advanceTimersByTimeAsync(0);
    const b = e.embeber(['b']);
    const bFalla = expect(b).rejects.toMatchObject({ causa: 'saturacion' });
    await vi.advanceTimersByTimeAsync(2000);
    await bFalla;
    liberar[0]!();
    expect(await a).toEqual([[1]]);
  });

  it('la llamada en cola avanza cuando se libera un cupo, y el cupo se libera también ante error', async () => {
    const orden: string[] = [];
    let primera = true;
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        orden.push(p.contents[0]!);
        if (primera) {
          primera = false;
          await new Promise((r) => setTimeout(r, 10));
          throw error(401);
        }
        return ok(p);
      }),
      { maxConcurrentes: 1, esperaMaxColaMs: 1000 },
    );
    const a = e.embeber(['a']);
    const b = e.embeber(['b']);
    await expect(a).rejects.toMatchObject({ causa: 'autenticacion' });
    expect(await b).toEqual([[0, 1, 0]]);
    expect(orden).toEqual(['a', 'b']);
  });

  it('el cupo se mantiene durante los reintentos', async () => {
    const vistas: string[] = [];
    let n = 0;
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        vistas.push(p.contents[0]!);
        n += 1;
        if (n === 1) throw error(429);
        return ok(p);
      }),
      { maxConcurrentes: 1, esperaMaxColaMs: 1000, esperar: async () => new Promise((r) => setTimeout(r, 5)), aleatorio: () => 0 },
    );
    await Promise.all([e.embeber(['a']), e.embeber(['b'])]);
    expect(vistas).toEqual(['a', 'a', 'b']);
  });
});

describe('EmbebedorVertex: lotes', () => {
  it('un lote con 429 se reintenta entero, una sola vez, sin repetir los lotes ya resueltos', async () => {
    const textos = Array.from({ length: MAX_TEXTOS_POR_LOTE + 5 }, (_, i) => `t${i}`);
    const llamadas: number[] = [];
    let falloSegundo = true;
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        llamadas.push(p.contents.length);
        if (p.contents.length === 5 && falloSegundo) {
          falloSegundo = false;
          throw error(429);
        }
        return ok(p);
      }),
      { esperar: async () => undefined, aleatorio: () => 0 },
    );
    const v = await e.embeber(textos);
    expect(v).toHaveLength(textos.length);
    expect(llamadas).toEqual([100, 5, 5]);
  });

  it('cada lote tiene su presupuesto: dos lotes de la consulta que reintentan una vez cada uno terminan bien', async () => {
    const textos = Array.from({ length: MAX_TEXTOS_POR_LOTE + 1 }, (_, i) => `t${i}`);
    let llamadas = 0;
    let t = 0;
    const e = new EmbebedorVertex(
      cliente(async (p) => {
        llamadas += 1;
        t += 1000;
        if (llamadas === 1 || llamadas === 3) throw error(429);
        return ok(p);
      }),
      { ahora: () => t, esperar: async () => undefined, aleatorio: () => 0 },
    );
    // El reloj corre 4 s en total: con un presupuesto global de 4,5 s el segundo lote no habría podido reintentar.
    // Entre lotes el reloj no se reinicia: cada llamada mide desde su propio inicio.
    expect(await e.embeber(textos)).toHaveLength(MAX_TEXTOS_POR_LOTE + 1);
    expect(llamadas).toBe(4);
  });

  it('un fallo en un lote posterior no devuelve vectores parciales', async () => {
    const textos = Array.from({ length: MAX_TEXTOS_POR_LOTE + 1 }, (_, i) => `t${i}`);
    const e = new EmbebedorVertex(cliente(async (p) => (p.contents.length === 1 ? Promise.reject(error(401)) : ok(p))));
    await expect(e.embeber(textos)).rejects.toMatchObject({ causa: 'autenticacion' });
  });

  it('con carga normal (sin fallos) hace una llamada por lote y nada más', async () => {
    let llamadas = 0;
    const e = new EmbebedorVertex(cliente(async (p) => { llamadas += 1; return ok(p); }));
    expect(await e.embeber([])).toEqual([]);
    expect(llamadas).toBe(0);
    await e.embeber(['a', 'b', 'c']);
    expect(llamadas).toBe(1);
  });
});

describe('EmbebedorVertex: indexación frente a consulta', () => {
  it('la consulta vence a los 2,5 s y la indexación aguanta 30 s sin vencer, con el mismo cliente lento', async () => {
    vi.useFakeTimers();
    const lento: Embed = (p) => new Promise((r) => setTimeout(() => r({ embeddings: p.contents.map(() => ({ values: [1] })) }), 20_000));
    const e = new EmbebedorVertex(cliente(lento));
    const consulta = expect(e.embeber(['a'])).rejects.toMatchObject({ causa: 'tiempo' });
    await vi.advanceTimersByTimeAsync(2500);
    await consulta;
    const indexar = e.embeberParaIndexar(['a']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await indexar).toEqual([[1]]);
  });

  it('la indexación vence a los 30 s con causa tiempo y no reintenta por tiempo', async () => {
    vi.useFakeTimers();
    let llamadas = 0;
    const e = new EmbebedorVertex(cliente(() => { llamadas += 1; return new Promise(() => undefined); }));
    const r = expect(e.embeberParaIndexar(['a'])).rejects.toMatchObject({ causa: 'tiempo' });
    await vi.advanceTimersByTimeAsync(30_000);
    await r;
    expect(llamadas).toBe(1);
  });

  it('la indexación no usa el semáforo de las consultas', async () => {
    vi.useFakeTimers();
    const e = new EmbebedorVertex(cliente(() => new Promise(() => undefined)), { maxConcurrentes: 1, esperaMaxColaMs: 100 });
    const q = e.embeber(['q']);
    q.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    const i = e.embeberParaIndexar(['i']);
    i.catch(() => undefined);
    // Pasada la cola de 100 ms ninguna falla con saturación: la indexación no hizo cola.
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(40_000);
    await expect(i).rejects.toMatchObject({ causa: 'tiempo' });
    await expect(q).rejects.toMatchObject({ causa: 'tiempo' });
  });
});
