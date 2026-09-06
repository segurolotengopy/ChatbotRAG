import { describe, expect, it } from 'vitest';
import type { GenerateContentResponse } from '@google/genai';
import { aContenidos, EmbebedorVertex, ErrorProveedor, ProveedorVertex, type ClienteGemini } from './indice.js';

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
});
