import { describe, expect, it } from 'vitest';
import type { ConverseCommandInput, ConverseCommandOutput } from '@aws-sdk/client-bedrock-runtime';
import { aMensajes, EmbebedorBedrock, ErrorProveedor, ProveedorBedrock, type ClienteBedrock } from './indice.js';

function clienteFalso(salida: Partial<ConverseCommandOutput>, capturado: { ultima?: ConverseCommandInput } = {}): ClienteBedrock {
  return {
    async converse(e) {
      capturado.ultima = e;
      return salida as ConverseCommandOutput;
    },
    async invocarJson() {
      return { embedding: [0.1, 0.2] };
    },
  };
}

describe('ProveedorBedrock', () => {
  it('traduce a Converse y devuelve texto', async () => {
    const cap: { ultima?: ConverseCommandInput } = {};
    const p = new ProveedorBedrock(clienteFalso({ output: { message: { role: 'assistant', content: [{ text: 'Hola.' }] } }, stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 1 } }, cap));
    const r = await p.generar({
      sistema: 'S',
      mensajes: [{ rol: 'usuario', contenido: 'hola' }],
      herramientas: [{ nombre: 'derivar_humano', descripcion: 'd', parametros: { type: 'object', properties: {} } }],
      parametros: { modelo: 'anthropic.claude-haiku-4-5', temperatura: 0.1, maxTokensSalida: 200 },
    });
    expect(r).toEqual({ texto: 'Hola.', llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 5, tokensSalida: 1 } });
    expect(cap.ultima?.system).toEqual([{ text: 'S' }]);
    expect(cap.ultima?.toolConfig?.tools).toHaveLength(1);
    expect(cap.ultima?.inferenceConfig).toEqual({ temperature: 0.1, maxTokens: 200 });
  });

  it('convierte toolUse en llamadas', async () => {
    const p = new ProveedorBedrock(clienteFalso({ output: { message: { role: 'assistant', content: [{ toolUse: { toolUseId: 't1', name: 'recomendar_opcion', input: { prioridad: 'precio' } } }] } }, stopReason: 'tool_use' }));
    const r = await p.generar({ sistema: '', mensajes: [], herramientas: [], parametros: { modelo: 'm', temperatura: 0, maxTokensSalida: 1 } });
    expect(r.motivoFin).toBe('herramienta');
    expect(r.llamadasHerramienta).toEqual([{ id: 't1', nombre: 'recomendar_opcion', argumentos: { prioridad: 'precio' } }]);
  });

  it('serializa el hilo de herramientas', () => {
    const m = aMensajes([
      { rol: 'usuario', contenido: 'x' },
      { rol: 'asistente_herramientas', texto: 'un momento', llamadas: [{ id: 't1', nombre: 'derivar_humano', argumentos: {} }] },
      { rol: 'herramienta', idLlamada: 't1', nombre: 'derivar_humano', resultado: { ok: true } },
    ]);
    expect(m[1]!.content).toHaveLength(2);
    expect(m[2]!.role).toBe('user');
    expect(m[2]!.content![0]).toMatchObject({ toolResult: { toolUseId: 't1' } });
  });

  it('envuelve errores del SDK', async () => {
    const roto: ClienteBedrock = { converse: async () => { throw new Error('AccessDenied'); }, invocarJson: async () => ({}) };
    await expect(new ProveedorBedrock(roto).generar({ sistema: '', mensajes: [], herramientas: [], parametros: { modelo: 'm', temperatura: 0, maxTokensSalida: 1 } })).rejects.toThrow(ErrorProveedor);
  });
});

describe('EmbebedorBedrock', () => {
  it('devuelve un vector por texto', async () => {
    const e = new EmbebedorBedrock(clienteFalso({}), { dimension: 2 });
    expect(await e.embeber(['a', 'b'])).toEqual([[0.1, 0.2], [0.1, 0.2]]);
  });
});
