/** Pruebas del embebedor con memoria y del tope de tiempo (H4a). Reloj y temporizador inyectados. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Embebedor } from '../puertos/proveedor-llm.js';
import { EmbebedorConMemoria, ErrorEmbebedorTiempo, consultarEmbedding, embeberConTiempo } from './embebedor-memo.js';
import type { Programador } from './embebedor-memo.js';

/** Embebedor que cuenta las llamadas y que se resuelve cuando la prueba lo decide. */
function falso(dimension = 2) {
  const llamadas: string[][] = [];
  const pendientes: Array<{ resolver: (m: number[][]) => void; rechazar: (e: Error) => void }> = [];
  const e: Embebedor = {
    nombre: 'falso',
    dimension,
    embeber: (textos) => {
      llamadas.push([...textos]);
      return new Promise<number[][]>((resolver, rechazar) => pendientes.push({ resolver, rechazar }));
    },
  };
  const responder = (i = pendientes.length - 1) => pendientes[i]?.resolver(llamadas[i]?.map((t) => [t.length, 1]) ?? []);
  return { e, llamadas, pendientes, responder };
}

describe('EmbebedorConMemoria: vía de indexación', () => {
  it('delega en embeberParaIndexar del interno, sin memoria (dos llamadas iguales = dos llamadas)', async () => {
    const vias: string[][] = [];
    const interno: Embebedor = {
      nombre: 'falso', dimension: 2,
      async embeber() { throw new Error('no debe usarse'); },
      async embeberParaIndexar(t) { vias.push([...t]); return t.map(() => [1, 0]); },
    };
    const e = new EmbebedorConMemoria(interno);
    await e.embeberParaIndexar(['a', 'b']);
    await e.embeberParaIndexar(['a', 'b']);
    expect(vias).toEqual([['a', 'b'], ['a', 'b']]);
    expect(e.tamano).toBe(0);
  });

  it('sin embeberParaIndexar en el interno usa embeber (con el this correcto)', async () => {
    const interno = {
      nombre: 'falso', dimension: 2, visto: 0,
      async embeber(this: { visto: number }, t: string[]) { this.visto += 1; return t.map(() => [1, 0]); },
    };
    expect(await new EmbebedorConMemoria(interno as Embebedor).embeberParaIndexar(['a'])).toEqual([[1, 0]]);
    expect(interno.visto).toBe(1);
  });
});

describe('EmbebedorConMemoria', () => {
  it('dos pedidos simultáneos del mismo texto hacen UNA sola llamada (enrutador y RAG comparten el vector)', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['hola']);
    const b = memo.embeber(['hola']);
    f.responder();
    expect(await a).toEqual([[4, 1]]);
    expect(await b).toEqual([[4, 1]]);
    expect(f.llamadas).toHaveLength(1);
    // Ya resuelto, un tercer pedido sigue sin llamar.
    expect(await memo.embeber(['hola'])).toEqual([[4, 1]]);
    expect(f.llamadas).toHaveLength(1);
    expect(memo.nombre).toBe('falso');
    expect(memo.dimension).toBe(2);
  });

  it('entrega copias: mutar el resultado no altera la memoria', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['hola']);
    f.responder();
    ((await a)[0] as number[])[0] = 999;
    expect(await memo.embeber(['hola'])).toEqual([[4, 1]]);
  });

  it('un lote pide al servicio solo lo que falta, sin repetir', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['uno']);
    f.responder();
    await a;
    const b = memo.embeber(['uno', 'dos', 'dos', 'tres']);
    f.responder();
    expect(await b).toEqual([[3, 1], [3, 1], [3, 1], [4, 1]]);
    expect(f.llamadas).toEqual([['uno'], ['dos', 'tres']]);
  });

  it('una lista vacía no llama', async () => {
    const f = falso();
    expect(await new EmbebedorConMemoria(f.e).embeber([])).toEqual([]);
    expect(f.llamadas).toHaveLength(0);
  });

  it('las entradas vencen a los 60 s (reloj inyectado)', async () => {
    const f = falso();
    let t = 1000;
    const memo = new EmbebedorConMemoria(f.e, { ahora: () => t });
    const a = memo.embeber(['hola']);
    f.responder();
    await a;
    t += 59_999;
    await memo.embeber(['hola']);
    expect(f.llamadas).toHaveLength(1);
    t += 1;
    const b = memo.embeber(['hola']);
    f.responder();
    await b;
    expect(f.llamadas).toHaveLength(2);
  });

  it('guarda a lo sumo 32 entradas: sale la más antigua', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    for (let i = 0; i < 33; i++) {
      const p = memo.embeber([`texto ${i}`]);
      f.responder();
      await p;
    }
    expect(memo.tamano).toBe(32);
    const otra = memo.embeber(['texto 0']);
    f.responder();
    await otra;
    expect(f.llamadas).toHaveLength(34);
  });

  it('un fallo no se memoriza: el siguiente pedido vuelve a llamar', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['hola']);
    f.pendientes[0]?.rechazar(new Error('cae'));
    await expect(a).rejects.toThrow('cae');
    expect(memo.tamano).toBe(0);
    const b = memo.embeber(['hola']);
    f.responder(1);
    await b;
    expect(f.llamadas).toHaveLength(2);
  });

  it('un servicio que devuelve de menos rechaza y no memoriza', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['uno', 'dos']);
    f.pendientes[0]?.resolver([[1, 1]]);
    await expect(a).rejects.toThrow();
    expect(memo.tamano).toBe(0);
  });

  it('un lote mayor que el máximo se resuelve igual, con una sola llamada', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e, { maximo: 2 });
    const textos = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
    const p = memo.embeber(textos);
    f.responder();
    expect(await p).toEqual([[3, 1], [3, 1], [4, 1], [6, 1], [5, 1]]);
    expect(f.llamadas).toHaveLength(1);
    expect(memo.tamano).toBe(2);
  });

  it('valida las opciones con un error claro', () => {
    const f = falso();
    for (const maximo of [0, -1, 1.5, Number.NaN]) expect(() => new EmbebedorConMemoria(f.e, { maximo })).toThrow(RangeError);
    for (const vidaMs of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => new EmbebedorConMemoria(f.e, { vidaMs })).toThrow(RangeError);
    expect(() => new EmbebedorConMemoria(f.e, { maximo: 1 })).not.toThrow();
  });

  it('una lista vacía devuelta por el servicio es un error controlado, no un TypeError', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['hola']);
    f.pendientes[0]?.resolver([]);
    const error = await a.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(TypeError);
    expect(memo.tamano).toBe(0);
  });

  it('la clave es el SHA-256: el texto no queda guardado en la memoria', async () => {
    const f = falso();
    const memo = new EmbebedorConMemoria(f.e);
    const a = memo.embeber(['TEXTO-PRIVADO-UNICO']);
    f.responder();
    await a;
    const claves = [...(memo as unknown as { memoria: Map<string, unknown> }).memoria.keys()];
    expect(claves).toHaveLength(1);
    expect(claves[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

/** Programador de prueba: el tiempo "vence" cuando la prueba llama a `disparar`. */
function programadorManual() {
  const acciones: Array<() => void> = [];
  const cancelados: number[] = [];
  const programar: Programador = (accion) => {
    const i = acciones.push(accion) - 1;
    return () => cancelados.push(i);
  };
  return { programar, disparar: () => acciones.forEach((a) => a()), cancelados };
}

describe('embeberConTiempo', () => {
  it('devuelve el resultado y cancela el temporizador', async () => {
    const f = falso();
    const p = programadorManual();
    const r = embeberConTiempo(f.e, ['hola'], 500, p.programar);
    f.responder();
    expect(await r).toEqual([[4, 1]]);
    expect(p.cancelados).toEqual([0]);
  });

  it('pasado el tope rechaza con ErrorEmbebedorTiempo', async () => {
    const f = falso();
    const p = programadorManual();
    const r = embeberConTiempo(f.e, ['hola'], 500, p.programar);
    p.disparar();
    await expect(r).rejects.toBeInstanceOf(ErrorEmbebedorTiempo);
  });

  it('un tope inválido es un error de configuración claro', () => {
    const f = falso();
    for (const ms of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => embeberConTiempo(f.e, ['hola'], ms)).toThrow(RangeError);
  });

  it('un embebedor que lanza de forma síncrona rechaza y cancela el temporizador', async () => {
    const p = programadorManual();
    const roto: Embebedor = { nombre: 'roto', dimension: 2, embeber: () => { throw new Error('síncrono'); } };
    await expect(embeberConTiempo(roto, ['hola'], 500, p.programar)).rejects.toThrow('síncrono');
    expect(p.cancelados).toEqual([0]);
  });

  it('con el temporizador real y un tope corto también vence', async () => {
    const f = falso();
    await expect(embeberConTiempo(f.e, ['hola'], 5)).rejects.toBeInstanceOf(ErrorEmbebedorTiempo);
  });
});

describe('consultarEmbedding', () => {
  it('traduce éxito, error y tiempo a la consulta del enrutador, sin rechazar nunca', async () => {
    const f = falso();
    const p = programadorManual();
    const ok = consultarEmbedding(f.e, 'hola', 500, p.programar);
    f.responder();
    expect(await ok).toEqual({ estado: 'ok', vector: [4, 1] });

    const g = falso();
    const err = consultarEmbedding(g.e, 'hola', 500, p.programar);
    g.pendientes[0]?.rechazar(new Error('cae con TEXTO'));
    expect(await err).toEqual({ estado: 'error' });

    const h = falso();
    const q = programadorManual();
    const tiempo = consultarEmbedding(h.e, 'hola', 500, q.programar);
    q.disparar();
    expect(await tiempo).toEqual({ estado: 'tiempo' });
  });

  it('un tope inválido lanza RangeError; un embebedor que lanza de forma síncrona da error', async () => {
    const f = falso();
    await expect(consultarEmbedding(f.e, 'hola', 0)).rejects.toThrow(RangeError);
    const roto: Embebedor = { nombre: 'roto', dimension: 2, embeber: () => { throw new Error('síncrono'); } };
    expect(await consultarEmbedding(roto, 'hola', 500, programadorManual().programar)).toEqual({ estado: 'error' });
  });

  it('un servicio que devuelve una cantidad distinta es un error', async () => {
    const f = falso();
    const r = consultarEmbedding(f.e, 'hola', 500, programadorManual().programar);
    f.pendientes[0]?.resolver([]);
    expect(await r).toEqual({ estado: 'error' });
  });
});

describe('estructura', () => {
  it('el archivo no usa red, entorno ni expresiones construidas', () => {
    const fuente = readFileSync(new URL('./embebedor-memo.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Math.random']) expect(fuente).not.toContain(prohibido);
  });
});
