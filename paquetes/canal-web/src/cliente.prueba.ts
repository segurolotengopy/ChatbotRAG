import { describe, expect, it } from 'vitest';
import { ClienteChatbotRAG, ErrorServicio } from './cliente.js';
import { nuevoIdConversacion } from './contrato.js';

describe('ClienteChatbotRAG', () => {
  it('envía Bearer, cuerpo JSON y devuelve la respuesta tipada', async () => {
    let capturado: { url: string; init: RequestInit } | null = null;
    const fetchFalso = (async (url: string | URL | Request, init?: RequestInit) => {
      capturado = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ ok: true, texto: 'hola', respaldo: [], avisos: [] }), { status: 200 });
    }) as typeof fetch;
    const c = new ClienteChatbotRAG({ urlBase: 'https://api.ejemplo.com/', clave: 'clave-larga-de-prueba-123456', fetch: fetchFalso });
    const r = await c.enviar('web_abc12345', { texto: 'hola', perfilId: 'X' });
    expect(r.texto).toBe('hola');
    const cap = capturado as unknown as { url: string; init: RequestInit };
    expect(cap.url).toBe('https://api.ejemplo.com/v1/conversaciones/web_abc12345/mensajes');
    expect((cap.init.headers as Record<string, string>)['authorization']).toBe('Bearer clave-larga-de-prueba-123456');
    expect(JSON.parse(String(cap.init.body))).toEqual({ texto: 'hola', perfilId: 'X' });
  });

  it('el cuerpo incluye `pagina` cuando se indica y el respaldo admite `origen`', async () => {
    let cuerpo: unknown = null;
    const fetchFalso = (async (_url: string | URL | Request, init?: RequestInit) => {
      cuerpo = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ ok: true, texto: 'hola', respaldo: [{ fuenteId: 'a', titulo: 'A', version: 'v1', puntaje: 1, origen: 'pagina' }], avisos: [] }), { status: 200 });
    }) as typeof fetch;
    const c = new ClienteChatbotRAG({ urlBase: 'https://api.ejemplo.com', fetch: fetchFalso });
    const r = await c.enviar('web_abc12345', { texto: 'hola', pagina: 'plan' });
    expect(cuerpo).toEqual({ texto: 'hola', pagina: 'plan' });
    expect(r.respaldo[0]?.origen).toBe('pagina');
  });

  it('convierte errores HTTP en ErrorServicio con el motivo', async () => {
    const fetchFalso = (async () => new Response(JSON.stringify({ ok: false, motivo: 'NO_AUTORIZADO' }), { status: 401 })) as typeof fetch;
    const c = new ClienteChatbotRAG({ urlBase: 'https://api.ejemplo.com', fetch: fetchFalso });
    await expect(c.describirAgente()).rejects.toMatchObject({ estado: 401, motivo: 'NO_AUTORIZADO' });
    await expect(c.describirAgente()).rejects.toBeInstanceOf(ErrorServicio);
  });

  it('genera ids de conversación válidos', () => {
    expect(nuevoIdConversacion('web')).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$/);
  });
});
