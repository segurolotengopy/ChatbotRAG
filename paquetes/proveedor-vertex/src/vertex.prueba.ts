import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { cargarCalibracion, verificarCalibracion, VERSION_REGLA_DECISION } from '@chatbotrag/nucleo';
import { agruparPorPresupuesto, aContenidos, clasificarCausa, EmbebedorVertex, ErrorProveedor, MAX_CARACTERES_POR_LOTE, MAX_TEXTOS_POR_LOTE, ProveedorVertex, Semaforo, type ClienteGemini } from './indice.js';

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
  it('el nombre lleva el modelo efectivo y una calibración medida con otro modelo no es apta', () => {
    const a = new EmbebedorVertex(clienteFalso({}));
    const b = new EmbebedorVertex(clienteFalso({}), { modelo: 'text-embedding-006' });
    expect(a.nombre).toBe('vertex-embeddings:text-embedding-005');
    expect(b.nombre).toBe('vertex-embeddings:text-embedding-006');
    const sha = 'a'.repeat(64);
    const cal = cargarCalibracion(
      JSON.stringify({
        formato: 1, regla: VERSION_REGLA_DECISION, banco_sha256: sha, evaluacion_sha256: sha, proveedor: 'vertex', modelo: a.nombre, dimension: a.dimension,
        umbral_fijo: 0.8, umbral_derivacion: 0.7, margen: 0.05, valido: true, motivos_invalidez: [], control: { total: 40, confusiones: 0, falsos_positivos: 0 }, medido: '2026-11-05',
      }),
    );
    expect(verificarCalibracion(cal, { bancoSha256: sha, modelo: a.nombre, dimension: a.dimension }).semanticaApta).toBe(true);
    expect(verificarCalibracion(cal, { bancoSha256: sha, modelo: b.nombre, dimension: b.dimension }).semanticaApta).toBe(false);
  });

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

  it('un 503 y luego bueno: 2 llamadas (con la espera de la cuota)', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('no disponible', 503), 'bueno']);
    expect((await new ProveedorVertex(cliente, { esperar: async () => undefined }).generar(peticion)).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
  });

  it('un 500 se reintenta', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('interno', 500), 'bueno']);
    expect((await new ProveedorVertex(cliente).generar(peticion)).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
  });

  it('un 429 (cuota) agotados sus 2 reintentos sale con causa cuota tras 3 llamadas', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('cuota', 429), conEstado('cuota', 429), conEstado('cuota', 429), 'bueno']);
    const esperas: number[] = [];
    const proveedor = new ProveedorVertex(cliente, { esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0 });
    await expect(proveedor.generar(peticion)).rejects.toSatisfy((e: unknown) => e instanceof ErrorProveedor && e.causa === 'cuota' && /cuota/.test(e.message));
    expect(senales).toHaveLength(3);
    expect(esperas).toEqual([400, 1000]);
  });

  it('400, 401 y 403 salen en 1 llamada', async () => {
    for (const status of [400, 401, 403]) {
      const { cliente, senales } = clienteGuionado([conEstado('rechazo', status), 'bueno']);
      await expect(new ProveedorVertex(cliente).generar(peticion)).rejects.toThrow(ErrorProveedor);
      expect(senales).toHaveLength(1);
    }
  });

  it('un 400 cuyo mensaje cita ETIMEDOUT sale en 1 llamada', async () => {
    const { cliente, senales } = clienteGuionado([conEstado('petición inválida: ETIMEDOUT', 400), 'bueno']);
    await expect(new ProveedorVertex(cliente).generar(peticion)).rejects.toThrow(ErrorProveedor);
    expect(senales).toHaveLength(1);
  });

  it('un error de red (fetch failed) se reintenta y devuelve la respuesta buena', async () => {
    const { cliente, senales } = clienteGuionado([new Error('fetch failed'), 'bueno']);
    expect((await new ProveedorVertex(cliente).generar(peticion)).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
  });

  it('un `code` de texto ECONNRESET se reintenta y devuelve la respuesta buena', async () => {
    const { cliente, senales } = clienteGuionado([Object.assign(new Error('socket'), { code: 'ECONNRESET' }), 'bueno']);
    expect((await new ProveedorVertex(cliente).generar(peticion)).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
  });

  it('un cliente que respeta el abortSignal (AbortError) igual da el reintento exitoso', async () => {
    vi.useFakeTimers();
    const senales: AbortSignal[] = [];
    const cliente: ClienteGemini = {
      generateContent(p) {
        const senal = p.config.abortSignal!;
        senales.push(senal);
        if (senales.length > 1) return Promise.resolve(buena);
        return new Promise<GenerateContentResponse>((_, rechazar) => {
          senal.addEventListener('abort', () => rechazar(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
        });
      },
      embedContent: async () => ({ embeddings: [] }),
    };
    const promesa = new ProveedorVertex(cliente).generar(peticion);
    await vi.advanceTimersByTimeAsync(9000);
    expect((await promesa).texto).toBe('Hola.');
    expect(senales).toHaveLength(2);
    expect(senales[0]!.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opciones inválidas lanzan', () => {
    const { cliente } = clienteGuionado([]);
    expect(() => new ProveedorVertex(cliente, { tiempoMaximoMs: 0 })).toThrow(/tiempoMaximoMs/);
    expect(() => new ProveedorVertex(cliente, { tiempoMaximoMs: 1.5 })).toThrow(/tiempoMaximoMs/);
    expect(() => new ProveedorVertex(cliente, { reintentos: -1 })).toThrow(/reintentos/);
    expect(() => new ProveedorVertex(cliente, { reintentos: 0.5 })).toThrow(/reintentos/);
    expect(() => new ProveedorVertex(cliente, { tiempoMaximoMs: 1, reintentos: 0 })).not.toThrow();
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
    const { cliente, senales } = clienteGuionado([conEstado('no disponible', 502), 'bueno']);
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

describe('clasificarCausa', () => {
  const conEstado = (status: number, mensaje = 'x') => Object.assign(new Error(mensaje), { status });
  it('clasifica por status', () => {
    expect(clasificarCausa(conEstado(429))).toBe('cuota');
    expect(clasificarCausa(conEstado(401))).toBe('autenticacion');
    expect(clasificarCausa(conEstado(403))).toBe('autenticacion');
    expect(clasificarCausa(conEstado(404))).toBe('modelo');
    expect(clasificarCausa(conEstado(400))).toBe('otro');
    expect(clasificarCausa(conEstado(500))).toBe('servidor');
    expect(clasificarCausa(conEstado(502))).toBe('servidor');
    expect(clasificarCausa(conEstado(503))).toBe('saturacion');
    expect(clasificarCausa(conEstado(504))).toBe('tiempo');
    expect(clasificarCausa(conEstado(418))).toBe('otro');
  });
  it('clasifica por code numérico y de texto', () => {
    expect(clasificarCausa(Object.assign(new Error('x'), { code: 429 }))).toBe('cuota');
    expect(clasificarCausa(Object.assign(new Error('x'), { code: 404 }))).toBe('modelo');
    expect(clasificarCausa(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe('tiempo');
    expect(clasificarCausa(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('otro');
  });
  it('clasifica por mensaje solo cuando no hay número, y un número manda sobre el texto', () => {
    expect(clasificarCausa(new Error('{"status":"RESOURCE_EXHAUSTED"}'))).toBe('cuota');
    expect(clasificarCausa(new Error('connect ETIMEDOUT 1.2.3.4'))).toBe('tiempo');
    expect(clasificarCausa(new Error('Request timed out'))).toBe('tiempo');
    expect(clasificarCausa(conEstado(400, 'petición inválida: ETIMEDOUT'))).toBe('otro');
    expect(clasificarCausa(conEstado(403, 'RESOURCE_EXHAUSTED'))).toBe('autenticacion');
  });
  it('lo desconocido es otro', () => {
    expect(clasificarCausa(new Error('boom'))).toBe('otro');
    expect(clasificarCausa('texto')).toBe('otro');
    expect(clasificarCausa(null)).toBe('otro');
  });
});

describe('ProveedorVertex: causa, reintento del 429 y semáforo', () => {
  const peticion = { sistema: 'S', mensajes: [{ rol: 'usuario' as const, contenido: 'secreto-del-usuario' }], herramientas: [], parametros: { modelo: 'gemini-2.5-flash', temperatura: 0, maxTokensSalida: 100 } };
  const buena = { candidates: [{ content: { role: 'model', parts: [{ text: 'Hola.' }] }, finishReason: 'STOP' as never }] } as unknown as GenerateContentResponse;
  const conEstado = (status: number) => Object.assign(new Error(`estado ${status}`), { status });

  function cliente(pasos: Array<'bueno' | Error>) {
    let llamadas = 0;
    const c: ClienteGemini = {
      generateContent: () => {
        const paso = pasos[llamadas++] ?? 'bueno';
        return paso === 'bueno' ? Promise.resolve(buena) : Promise.reject(paso);
      },
      embedContent: async () => ({ embeddings: [] }),
    };
    return { c, llamadas: () => llamadas };
  }
  afterEach(() => {
    vi.useRealTimers();
  });

  it('el error lleva la causa según el estado', async () => {
    for (const [status, causa] of [[401, 'autenticacion'], [404, 'modelo'], [400, 'otro']] as const) {
      const { c } = cliente([conEstado(status)]);
      await expect(new ProveedorVertex(c).generar(peticion)).rejects.toMatchObject({ causa });
    }
  });

  it('un 429 y luego respuesta buena: 2 llamadas, con la espera de 400-900 ms', async () => {
    const { c, llamadas } = cliente([conEstado(429), 'bueno']);
    const esperas: number[] = [];
    const r = await new ProveedorVertex(c, { esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0.999 }).generar(peticion);
    expect(r.texto).toBe('Hola.');
    expect(llamadas()).toBe(2);
    expect(esperas).toEqual([900]);
  });

  it('dos 429 y luego buena: 3 llamadas; la segunda espera 1000-2000 ms', async () => {
    const { c, llamadas } = cliente([conEstado(429), conEstado(429), 'bueno']);
    const esperas: number[] = [];
    await new ProveedorVertex(c, { esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0.5 }).generar(peticion);
    expect(llamadas()).toBe(3);
    expect(esperas).toEqual([650, 1500]);
  });

  it('otros estados no hacen reintento por cuota (400/401/403/404)', async () => {
    for (const status of [400, 401, 403, 404]) {
      const { c, llamadas } = cliente([conEstado(status), 'bueno']);
      const esperar = vi.fn(async () => undefined);
      await expect(new ProveedorVertex(c, { esperar }).generar(peticion)).rejects.toThrow(ErrorProveedor);
      expect(llamadas()).toBe(1);
      expect(esperar).not.toHaveBeenCalled();
    }
  });

  it('no reintenta el 429 si el siguiente intento no cabe en el presupuesto', async () => {
    const { c, llamadas } = cliente([conEstado(429), 'bueno']);
    // Reloj: la primera lectura (inicio) es 0 y la siguiente 10 000 ms; 10 000 + 400 + 9 000 > 18 000.
    const lecturas = [0, 10_000];
    const ahora = () => lecturas.shift() ?? 10_000;
    await expect(new ProveedorVertex(c, { ahora, esperar: async () => undefined, aleatorio: () => 0 }).generar(peticion)).rejects.toMatchObject({ causa: 'cuota' });
    expect(llamadas()).toBe(1);
  });

  it('reintentosCuota: 0 desactiva el reintento del 429', async () => {
    const { c, llamadas } = cliente([conEstado(429), 'bueno']);
    await expect(new ProveedorVertex(c, { reintentosCuota: 0 }).generar(peticion)).rejects.toMatchObject({ causa: 'cuota' });
    expect(llamadas()).toBe(1);
  });

  it('un 500 sigue con su reintento sin espera (comportamiento normal intacto)', async () => {
    const { c, llamadas } = cliente([conEstado(500), 'bueno']);
    const esperar = vi.fn(async () => undefined);
    expect((await new ProveedorVertex(c, { esperar }).generar(peticion)).texto).toBe('Hola.');
    expect(llamadas()).toBe(2);
    expect(esperar).not.toHaveBeenCalled();
  });

  it('un 503 se reintenta con espera y jitter como el 429; agotado, sale con causa saturacion', async () => {
    const { c, llamadas } = cliente([conEstado(503), conEstado(503), conEstado(503), 'bueno']);
    const esperas: number[] = [];
    await expect(new ProveedorVertex(c, { esperar: async (ms) => void esperas.push(ms), aleatorio: () => 0 }).generar(peticion)).rejects.toMatchObject({ causa: 'saturacion' });
    expect(llamadas()).toBe(3);
    expect(esperas).toEqual([400, 1000]);
  });

  it('un 500 y un 502 llevan causa servidor y se reintentan una vez sin espera; el 504 lleva causa tiempo', async () => {
    for (const [status, causa] of [[500, 'servidor'], [502, 'servidor'], [504, 'tiempo']] as const) {
      const { c, llamadas } = cliente([conEstado(status), conEstado(status), 'bueno']);
      const esperar = vi.fn(async () => undefined);
      await expect(new ProveedorVertex(c, { esperar }).generar(peticion)).rejects.toMatchObject({ causa });
      expect(llamadas()).toBe(2);
      expect(esperar).not.toHaveBeenCalled();
    }
  });

  describe('presupuesto de latencia con reloj inyectado', () => {
    /** Cliente cuyas llamadas ignoran la señal: la primera dura `primeraMs` y responde bien; las demás nunca resuelven. */
    const lento = (llamadasEn: number[], primeraMs: number): ClienteGemini => ({
      generateContent: () => {
        llamadasEn.push(Date.now());
        return llamadasEn.length === 1 ? new Promise<GenerateContentResponse>((r) => setTimeout(() => r(buena), primeraMs)) : new Promise<GenerateContentResponse>(() => undefined);
      },
      embedContent: async () => ({ embeddings: [] }),
    });

    it('cola 30 ms + vencimiento 90 ms: el reintento transitorio no cabe en 180 ms y no se hace', async () => {
      vi.useFakeTimers();
      const llamadasEn: number[] = [];
      const c = lento(llamadasEn, 30);
      const p = new ProveedorVertex(c, { maxConcurrentes: 1, tiempoMaximoMs: 90, presupuestoMs: 180, ahora: () => Date.now() });
      const inicio = Date.now();
      const primera = p.generar(peticion);
      const segunda = p.generar(peticion);
      let fin = 0;
      const asercion = expect(segunda.catch((e: unknown) => ((fin = Date.now()), Promise.reject(e)))).rejects.toMatchObject({ causa: 'tiempo' });
      await vi.advanceTimersByTimeAsync(200);
      await primera;
      await asercion;
      expect(llamadasEn).toEqual([inicio, inicio + 30]);
      expect(fin - inicio).toBe(120);
    });

    it('sin cola, vencimiento 90 ms + reintento 90 ms caben justo en 180 ms y el reintento sí se hace', async () => {
      vi.useFakeTimers();
      const llamadasEn: number[] = [];
      const c: ClienteGemini = { generateContent: () => (llamadasEn.push(Date.now()), new Promise<GenerateContentResponse>(() => undefined)), embedContent: async () => ({ embeddings: [] }) };
      const p = new ProveedorVertex(c, { tiempoMaximoMs: 90, presupuestoMs: 180, ahora: () => Date.now() });
      const inicio = Date.now();
      let fin = 0;
      const asercion = expect(p.generar(peticion).catch((e: unknown) => ((fin = Date.now()), Promise.reject(e)))).rejects.toMatchObject({ causa: 'tiempo' });
      await vi.advanceTimersByTimeAsync(200);
      await asercion;
      expect(llamadasEn).toEqual([inicio, inicio + 90]);
      expect(fin - inicio).toBe(180);
    });
  });

  it('el tiempo agotado lleva causa tiempo', async () => {
    vi.useFakeTimers();
    const c: ClienteGemini = { generateContent: () => new Promise<GenerateContentResponse>(() => undefined), embedContent: async () => ({ embeddings: [] }) };
    const asercion = expect(new ProveedorVertex(c).generar(peticion)).rejects.toMatchObject({ causa: 'tiempo' });
    await vi.advanceTimersByTimeAsync(18_000);
    await asercion;
  });

  it('valida las opciones nuevas', () => {
    const { c } = cliente([]);
    expect(() => new ProveedorVertex(c, { maxConcurrentes: 0 })).toThrow(/maxConcurrentes/);
    expect(() => new ProveedorVertex(c, { esperaMaxColaMs: 0 })).toThrow(/esperaMaxColaMs/);
    expect(() => new ProveedorVertex(c, { reintentosCuota: 3 })).toThrow(/reintentosCuota/);
    expect(() => new ProveedorVertex(c, { presupuestoMs: 0 })).toThrow(/presupuestoMs/);
  });

  describe('concurrencia', () => {
    /** Cliente cuyas llamadas quedan pendientes hasta que la prueba las resuelve. */
    function clienteControlado() {
      const pendientes: Array<{ resolver: () => void; rechazar: (e: Error) => void }> = [];
      let simultaneas = 0;
      let maxima = 0;
      const c: ClienteGemini = {
        generateContent: () => {
          simultaneas += 1;
          maxima = Math.max(maxima, simultaneas);
          return new Promise<GenerateContentResponse>((resolver, rechazar) => {
            pendientes.push({
              resolver: () => {
                simultaneas -= 1;
                resolver(buena);
              },
              rechazar: (e) => {
                simultaneas -= 1;
                rechazar(e);
              },
            });
          });
        },
        embedContent: async () => ({ embeddings: [] }),
      };
      return { c, pendientes, maxima: () => maxima };
    }
    const vaciar = () => new Promise<void>((r) => setImmediate(r));

    it('respeta el máximo de llamadas simultáneas y atiende la cola en orden al liberar', async () => {
      const { c, pendientes, maxima } = clienteControlado();
      const p = new ProveedorVertex(c, { maxConcurrentes: 2 });
      const tareas = [1, 2, 3, 4].map(() => p.generar(peticion));
      await vaciar();
      expect(pendientes).toHaveLength(2);
      pendientes[0]!.resolver();
      await vaciar();
      expect(pendientes).toHaveLength(3);
      pendientes[1]!.resolver();
      await vaciar();
      expect(pendientes).toHaveLength(4);
      pendientes[2]!.resolver();
      pendientes[3]!.resolver();
      await Promise.all(tareas);
      expect(maxima()).toBe(2);
    });

    it('por omisión admite 4 simultáneas', async () => {
      const { c, pendientes } = clienteControlado();
      const p = new ProveedorVertex(c);
      const tareas = Array.from({ length: 6 }, () => p.generar(peticion));
      await vaciar();
      expect(pendientes).toHaveLength(4);
      for (let i = 0; i < 6; i++) {
        pendientes[i]?.resolver();
        await vaciar();
      }
      await Promise.all(tareas);
    });

    it('si la cola espera más de esperaMaxColaMs falla rápido con causa saturacion', async () => {
      vi.useFakeTimers();
      const { c, pendientes } = clienteControlado();
      const p = new ProveedorVertex(c, { maxConcurrentes: 1, esperaMaxColaMs: 3000 });
      const primera = p.generar(peticion);
      const segunda = p.generar(peticion);
      const asercion = expect(segunda).rejects.toSatisfy((e: unknown) => e instanceof ErrorProveedor && e.causa === 'saturacion' && !e.message.includes('secreto-del-usuario'));
      await vi.advanceTimersByTimeAsync(3000);
      await asercion;
      expect(pendientes).toHaveLength(1);
      pendientes[0]!.resolver();
      await primera;
    });

    it('un error libera el cupo para el siguiente', async () => {
      const { c, pendientes } = clienteControlado();
      const p = new ProveedorVertex(c, { maxConcurrentes: 1 });
      const primera = p.generar(peticion);
      const segunda = p.generar(peticion);
      await vaciar();
      pendientes[0]!.rechazar(Object.assign(new Error('rechazo'), { status: 400 }));
      await expect(primera).rejects.toThrow(ErrorProveedor);
      await vaciar();
      expect(pendientes).toHaveLength(2);
      pendientes[1]!.resolver();
      expect((await segunda).texto).toBe('Hola.');
    });

    it('el cupo vencido de la cola no se concede después (sin fuga de cupos)', async () => {
      vi.useFakeTimers();
      const s = new Semaforo(1, 100);
      const liberar = await s.adquirir();
      const espera = s.adquirir();
      const asercion = expect(espera).rejects.toThrow(/simultáneas/);
      await vi.advanceTimersByTimeAsync(100);
      await asercion;
      expect(s.enCola).toBe(0);
      liberar();
      liberar();
      // Tras liberar (dos veces: idempotente) queda exactamente 1 cupo libre.
      const a = await s.adquirir();
      const b = s.adquirir();
      const rechazo = expect(b).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(100);
      await rechazo;
      a();
    });
  });
});
