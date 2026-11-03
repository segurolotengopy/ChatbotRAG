import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { agruparPorPresupuesto, aContenidos, EmbebedorVertex, ErrorProveedor, MAX_CARACTERES_POR_LOTE, MAX_TEXTOS_POR_LOTE, ProveedorVertex, type ClienteGemini } from './indice.js';

function clienteFalso(respuesta: Partial<GenerateContentResponse>, capturar: { ultima?: unknown } = {}): ClienteGemini {
  return {
    async generateContent(p) {
      capturar.ultima = p;
      return respuesta as GenerateContentResponse;
    },
    async embedContent(p) {
      return { embeddings: p.contents.map((_, i) => ({ values: [i, 1, 0] })) };
    },
  };
}

describe('ProveedorVertex', () => {
  it('traduce la petición neutral al formato de Gemini y devuelve texto', async () => {
    const capturado: { ultima?: unknown } = {};
    const cliente = clienteFalso(
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Hola.' }] }, finishReason: 'STOP' as never }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } } as never,
      capturado,
    );
    const p = new ProveedorVertex(cliente);
    const r = await p.generar({
      sistema: 'SISTEMA',
      mensajes: [{ rol: 'usuario', contenido: 'hola' }],
      herramientas: [{ nombre: 'derivar_humano', descripcion: 'd', parametros: { type: 'object', properties: { motivo: { type: 'string', description: 'm' } } } }],
      parametros: { modelo: 'gemini-2.5-flash', temperatura: 0.2, maxTokensSalida: 300 },
    });
    expect(r).toEqual({ texto: 'Hola.', llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 10, tokensSalida: 2 } });
    const enviado = capturado.ultima as { model: string; config: { systemInstruction: string; tools: unknown[] }; contents: unknown[] };
    expect(enviado.model).toBe('gemini-2.5-flash');
    expect(enviado.config.systemInstruction).toBe('SISTEMA');
    expect(enviado.config.tools).toHaveLength(1);
    expect(enviado.contents).toEqual([{ role: 'user', parts: [{ text: 'hola' }] }]);
  });

  it('convierte llamadas a función y motivos de fin', async () => {
    const cliente = clienteFalso({
      candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: 'recomendar_opcion', args: { prioridad: 'precio' } } }] }, finishReason: 'STOP' as never }],
    } as never);
    const r = await new ProveedorVertex(cliente).generar({ sistema: '', mensajes: [{ rol: 'usuario', contenido: 'x' }], herramientas: [], parametros: { modelo: 'm', temperatura: 0, maxTokensSalida: 10 } });
    expect(r.motivoFin).toBe('herramienta');
    expect(r.llamadasHerramienta).toEqual([{ id: 'vx-1', nombre: 'recomendar_opcion', argumentos: { prioridad: 'precio' } }]);

    const truncado = clienteFalso({ candidates: [{ content: { role: 'model', parts: [{ text: 'a' }] }, finishReason: 'MAX_TOKENS' as never }] } as never);
    expect((await new ProveedorVertex(truncado).generar({ sistema: '', mensajes: [], herramientas: [], parametros: { modelo: 'm', temperatura: 0, maxTokensSalida: 10 } })).motivoFin).toBe('max_tokens');
  });

  it('serializa el hilo de herramientas (functionCall / functionResponse)', () => {
    const c = aContenidos([
      { rol: 'usuario', contenido: 'quiero hablar con alguien' },
      { rol: 'asistente_herramientas', texto: '', llamadas: [{ id: 'a1', nombre: 'derivar_humano', argumentos: { motivo: 'x' } }] },
      { rol: 'herramienta', idLlamada: 'a1', nombre: 'derivar_humano', resultado: { derivado: true } },
      { rol: 'herramienta', idLlamada: 'a2', nombre: 'otra', resultado: 'texto plano' },
    ]);
    expect(c).toHaveLength(3);
    expect(c[1]!.parts![0]!.functionCall).toMatchObject({ name: 'derivar_humano' });
    expect(c[2]!.parts).toHaveLength(2);
    expect(c[2]!.parts![1]!.functionResponse!.response).toEqual({ resultado: 'texto plano' });
  });

  it('envuelve errores del SDK con el nombre del modelo', async () => {
    const cliente: ClienteGemini = {
      generateContent: async () => {
        throw new Error('404 model no longer available');
      },
      embedContent: async () => ({ embeddings: [] }),
    };
    await expect(new ProveedorVertex(cliente).generar({ sistema: '', mensajes: [], herramientas: [], parametros: { modelo: 'gemini-viejo', temperatura: 0, maxTokensSalida: 1 } })).rejects.toThrow(ErrorProveedor);
    await expect(new ProveedorVertex(cliente).generar({ sistema: '', mensajes: [], herramientas: [], parametros: { modelo: 'gemini-viejo', temperatura: 0, maxTokensSalida: 1 } })).rejects.toThrow(/gemini-viejo/);
  });
});

describe('EmbebedorVertex', () => {
  it('devuelve un vector por texto y valida la cantidad', async () => {
    const e = new EmbebedorVertex(clienteFalso({}), { dimension: 3 });
    expect(await e.embeber(['a', 'b'])).toEqual([[0, 1, 0], [1, 1, 0]]);
    expect(await e.embeber([])).toEqual([]);
    const roto: ClienteGemini = { generateContent: async () => ({}) as GenerateContentResponse, embedContent: async () => ({ embeddings: [] }) };
    await expect(new EmbebedorVertex(roto).embeber(['a'])).rejects.toThrow(/devolvió 0 vectores/);
  });

  it('parte las peticiones por caracteres y por cantidad, sin perder ni reordenar textos', async () => {
    const peticiones: number[] = [];
    const cliente: ClienteGemini = {
      generateContent: async () => ({}) as GenerateContentResponse,
      async embedContent(p) {
        peticiones.push(p.contents.reduce((n, c) => n + String(c).length, 0));
        return { embeddings: p.contents.map((c) => ({ values: [String(c).length] })) };
      },
    };
    // 100 fragmentos de 900 caracteres: el caso que falló en staging (31 145 tokens en una sola petición).
    const textos = Array.from({ length: 534 }, (_, i) => 'x'.repeat(850 + (i % 50)));
    const vectores = await new EmbebedorVertex(cliente).embeber(textos);
    expect(vectores.map((v) => v[0])).toEqual(textos.map((t) => t.length));
    expect(peticiones.length).toBeGreaterThan(5);
    expect(Math.max(...peticiones)).toBeLessThanOrEqual(MAX_CARACTERES_POR_LOTE);
  });

  it('agruparPorPresupuesto: respeta el tope de textos, deja pasar un texto largo solo y no emite lotes vacíos', () => {
    expect(agruparPorPresupuesto([])).toEqual([]);
    const cortos = Array.from({ length: MAX_TEXTOS_POR_LOTE * 2 + 1 }, () => 'a');
    expect(agruparPorPresupuesto(cortos).map((l) => l.length)).toEqual([MAX_TEXTOS_POR_LOTE, MAX_TEXTOS_POR_LOTE, 1]);
    const largo = 'y'.repeat(MAX_CARACTERES_POR_LOTE + 5);
    expect(agruparPorPresupuesto(['a', largo, 'b'])).toEqual([['a'], [largo], ['b']]);
  });
});

describe('ProveedorVertex: razonamiento', () => {
  const base = { sistema: 'S', mensajes: [{ rol: 'usuario' as const, contenido: 'hola' }], herramientas: [] };
  const respuesta = { candidates: [{ content: { role: 'model', parts: [{ text: 'Hola.' }] }, finishReason: 'STOP' as never }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 40, thoughtsTokenCount: 900 } } as never;

  it('con `desactivado` envía thinkingBudget 0; con `automatico` o sin el parámetro no envía thinkingConfig', async () => {
    for (const [razonamiento, esperado] of [['desactivado', true], ['automatico', false], [undefined, false]] as const) {
      const capturado: { ultima?: unknown } = {};
      await new ProveedorVertex(clienteFalso(respuesta, capturado)).generar({
        ...base,
        parametros: { modelo: 'gemini-2.5-flash', temperatura: 0, maxTokensSalida: 100, ...(razonamiento ? { razonamiento } : {}) },
      });
      const config = (capturado.ultima as { config: Record<string, unknown> }).config;
      expect('thinkingConfig' in config).toBe(esperado);
      if (esperado) expect(config['thinkingConfig']).toEqual({ thinkingBudget: 0 });
    }
  });

  it('suma los tokens de razonamiento a los de salida (se cobran como salida)', async () => {
    const r = await new ProveedorVertex(clienteFalso(respuesta)).generar({ ...base, parametros: { modelo: 'gemini-2.5-flash', temperatura: 0, maxTokensSalida: 100 } });
    expect(r.uso).toEqual({ tokensEntrada: 10, tokensSalida: 940 });
  });
});

describe('ProveedorVertex: tiempo máximo y reintento', () => {
  const peticion = { sistema: 'S', mensajes: [{ rol: 'usuario' as const, contenido: 'secreto-del-usuario' }], herramientas: [], parametros: { modelo: 'gemini-2.5-flash', temperatura: 0, maxTokensSalida: 100 } };
  const buena = { candidates: [{ content: { role: 'model', parts: [{ text: 'Hola.' }] }, finishReason: 'STOP' as never }] } as unknown as GenerateContentResponse;

  type Paso = 'lento' | 'bueno' | Error;
  /** Cliente falso que ignora la señal en los pasos lentos (nunca resuelve) y registra cada llamada. */
  function clienteGuionado(pasos: Paso[]) {
    const senales: AbortSignal[] = [];
    const cliente: ClienteGemini = {
      generateContent(p) {
        if (p.config.abortSignal) senales.push(p.config.abortSignal);
        const paso = pasos[senales.length - 1] ?? 'bueno';
        if (paso === 'lento') return new Promise<GenerateContentResponse>(() => undefined);
        if (paso === 'bueno') return Promise.resolve(buena);
        return Promise.reject(paso);
      },
      embedContent: async () => ({ embeddings: [] }),
    };
    return { cliente, senales };
  }
  const conEstado = (mensaje: string, status: number) => Object.assign(new Error(mensaje), { status });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('un intento lento y el segundo bueno: devuelve la respuesta tras 2 llamadas, la primera abortada', async () => {
    vi.useFakeTimers();
    const { cliente, senales } = clienteGuionado(['lento', 'bueno']);
    const promesa = new ProveedorVertex(cliente).generar(peticion);
    await vi.advanceTimersByTimeAsync(9000);
    expect((await promesa).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
    expect(senales[0]!.aborted).toBe(true);
    expect(senales[1]!.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('dos intentos lentos: ErrorProveedor con «tiempo máximo» y sin el contenido de la petición', async () => {
    vi.useFakeTimers();
    const { cliente, senales } = clienteGuionado(['lento', 'lento']);
    const asercion = expect(new ProveedorVertex(cliente).generar(peticion)).rejects.toSatisfy((e: unknown) => e instanceof ErrorProveedor && e.message === 'Vertex (gemini-2.5-flash): tiempo máximo de 9000 ms agotado');
    await vi.advanceTimersByTimeAsync(18000);
    await asercion;
    expect(senales).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('un 429 y luego bueno: 2 llamadas', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('cuota', 429), 'bueno']);
    expect((await new ProveedorVertex(cliente).generar(peticion)).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
  });

  it('un error de red (fetch failed) se reintenta', async () => {
    const { cliente, senales } = clienteGuionado([new Error('fetch failed'), 'bueno']);
    await new ProveedorVertex(cliente).generar(peticion);
    expect(senales).toHaveLength(2);
  });

  it('un 404 (modelo retirado): 1 sola llamada y error', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('model no longer available', 404), 'bueno']);
    await expect(new ProveedorVertex(cliente).generar(peticion)).rejects.toThrow(/Vertex \(gemini-2.5-flash\): model no longer available/);
    expect(senales).toHaveLength(1);
  });

  it('un error desconocido: 1 sola llamada', async () => {
    const { cliente, senales } = clienteGuionado([new Error('algo raro'), 'bueno']);
    await expect(new ProveedorVertex(cliente).generar(peticion)).rejects.toThrow(ErrorProveedor);
    expect(senales).toHaveLength(1);
  });

  it('`reintentos: 0`: 1 llamada aunque el fallo sea transitorio', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('no disponible', 503), 'bueno']);
    await expect(new ProveedorVertex(cliente, { reintentos: 0 }).generar(peticion)).rejects.toThrow(/no disponible/);
    expect(senales).toHaveLength(1);
  });

  it('el temporizador queda limpio tras una respuesta rápida', async () => {
    vi.useFakeTimers();
    const { cliente } = clienteGuionado(['bueno']);
    await new ProveedorVertex(cliente).generar(peticion);
    expect(vi.getTimerCount()).toBe(0);
  });
});
