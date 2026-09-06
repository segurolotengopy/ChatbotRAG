import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { BitacoraEnMemoria } from '@chatbotrag/nucleo';
import { crearAplicacion } from './aplicacion.js';
import { armarAgentes } from './armar-agentes.js';
import { leerEntorno } from './entorno.js';
import { EjecutorHerramientasHttp } from './herramientas-http.js';

const CLAVE = 'clave-de-prueba-suficientemente-larga';
const CLAVE_HASH = createHash('sha256').update(CLAVE).digest('hex');

async function prepararDirectorio(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'chatbotrag-'));
  await mkdir(join(dir, 'corpus'), { recursive: true });
  await writeFile(join(dir, 'corpus', 'faq.md'), '# Preguntas frecuentes\n\n## Horario\nAtendemos de lunes a viernes de 9 a 18.\n\n## Envíos\nHacemos envíos a todo el país en 48 horas.');
  await writeFile(
    join(dir, 'tienda.json'),
    JSON.stringify({
      version: 1,
      id: 'tienda-prueba',
      identidad: { nombreAsistente: 'Ana', organizacion: 'Tienda Prueba' },
      conocimiento: { umbral: 0.3, fuentes: [{ id: 'faq', titulo: 'Preguntas frecuentes', version: '1', ruta: 'faq.md' }] },
      herramientas: [{ nombre: 'derivar_humano', descripcion: 'deriva' }],
      mensajes: {
        bienvenida: 'Hola, soy Ana.',
        errorTemporal: 'Error temporal.',
        fueraDeAlcance: 'Fuera de alcance.',
        sinRespaldo: 'Sin respaldo.',
        derivacion: 'Escriba a ventas@ejemplo.com.',
        entradaBloqueada: 'No comparta datos sensibles.',
        suspendido: 'No disponible.',
      },
      modelo: { proveedor: 'vertex', nombre: 'gemini-2.5-flash' },
      perfiles: { MAYORISTA: { nombre: 'Mayorista', mensajes: { bienvenida: 'Hola, mayorista.' } } },
    }),
  );
  return dir;
}

describe('servicio HTTP', () => {
  let app: FastifyInstance;
  let bitacora: BitacoraEnMemoria;
  const auth = { authorization: `Bearer ${CLAVE}` };

  beforeAll(async () => {
    const dir = await prepararDirectorio();
    const entorno = leerEntorno({
      CHATBOTRAG_DIR_CONFIGURACIONES: dir,
      CHATBOTRAG_PROVEEDOR_FORZADO: 'simulado',
      CHATBOTRAG_CLIENTES: JSON.stringify([{ id: 'web', agenteId: 'tienda-prueba', claveSha256: CLAVE_HASH, origenes: ['https://tienda.ejemplo.com'] }]),
      CHATBOTRAG_LIMITE_IP_MINUTO: '1000',
    });
    bitacora = new BitacoraEnMemoria();
    const agentes = await armarAgentes(entorno, { bitacora });
    app = await crearAplicacion({ entorno, agentes, registrar: false });
  });
  afterAll(async () => app.close());

  it('el entorno rechaza clientes malformados y exige PGVECTOR_URL con pgvector', () => {
    expect(() => leerEntorno({ CHATBOTRAG_CLIENTES: '[]' })).toThrow(/CHATBOTRAG_CLIENTES/);
    expect(() => leerEntorno({ CHATBOTRAG_CLIENTES: '[{"id":"ab","agenteId":"x-y-z","claveSha256":"zz"}]' })).toThrow(/claveSha256/);
    expect(() => leerEntorno({ CHATBOTRAG_CLIENTES: `[{"id":"ab","agenteId":"x-y-z","claveSha256":"${CLAVE_HASH}"}]`, CHATBOTRAG_INDICE: 'pgvector' })).toThrow(/PGVECTOR_URL/);
  });

  it('/salud responde sin autenticación y sin datos sensibles', async () => {
    const r = await app.inject({ method: 'GET', url: '/salud' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, agentes: [{ id: 'tienda-prueba', proveedor: 'simulado', indice: 'memoria', perfiles: 1 }] });
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('exige Bearer válido', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/agente' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/agente', headers: { authorization: 'Bearer otra-clave-incorrecta-larga' } })).statusCode).toBe(401);
  });

  it('describe el agente del cliente con perfiles y bienvenidas', async () => {
    const r = await app.inject({ method: 'GET', url: '/v1/agente', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, agente: { id: 'tienda-prueba', nombreAsistente: 'Ana' }, perfiles: [{ id: 'MAYORISTA', bienvenida: 'Hola, mayorista.' }], bienvenida: 'Hola, soy Ana.' });
  });

  it('responde un mensaje con respaldo y valida la forma', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_01/mensajes', headers: auth, payload: { texto: '¿Hacen envíos?' } });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.ok).toBe(true);
    expect(j.texto).toContain('48 horas');
    expect(j.respaldo[0].fuenteId).toBe('faq');

    expect((await app.inject({ method: 'POST', url: '/v1/conversaciones/x/mensajes', headers: auth, payload: { texto: 'hola' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_02/mensajes', headers: auth, payload: {} })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_02/mensajes', headers: auth, payload: { texto: 'a'.repeat(3000) } })).statusCode).toBe(413);
    expect((await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_02/mensajes', headers: auth, payload: { texto: 'hola', perfilId: 'NADA' } })).statusCode).toBe(404);
  });

  it('el perfil cambia la bienvenida y la conversación se puede olvidar', async () => {
    const r = await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_03/mensajes', headers: auth, payload: { texto: 'hola', perfilId: 'MAYORISTA' } });
    expect(r.json().texto).toBe('Hola, mayorista.');
    expect((await app.inject({ method: 'DELETE', url: '/v1/conversaciones/conv_prueba_03', headers: auth })).statusCode).toBe(204);
    const otra = await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_03/mensajes', headers: auth, payload: { texto: 'hola', perfilId: 'MAYORISTA' } });
    expect(otra.json().avisos).toContain('bienvenida'); // volvió a ser un saludo inicial
  });

  it('CORS solo para los orígenes del cliente', async () => {
    const ok = await app.inject({ method: 'OPTIONS', url: '/v1/agente', headers: { origin: 'https://tienda.ejemplo.com', 'access-control-request-method': 'GET' } });
    expect(ok.headers['access-control-allow-origin']).toBe('https://tienda.ejemplo.com');
    const no = await app.inject({ method: 'OPTIONS', url: '/v1/agente', headers: { origin: 'https://malo.ejemplo.com', 'access-control-request-method': 'GET' } });
    expect(no.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('la bitácora del servicio no contiene texto de mensajes', async () => {
    await app.inject({ method: 'POST', url: '/v1/conversaciones/conv_prueba_04/mensajes', headers: auth, payload: { texto: 'TEXTO-SECRETO-DEL-USUARIO' } });
    expect(JSON.stringify(bitacora.eventos)).not.toContain('TEXTO-SECRETO');
  });
});

describe('EjecutorHerramientasHttp', () => {
  it('firma con HMAC, envía solo el hash de la conversación y respeta el tiempo máximo', async () => {
    let capturado: { url: string; init: RequestInit } | null = null;
    const fetchFalso = (async (url: string | URL | Request, init?: RequestInit) => {
      capturado = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ resultado: { libres: ['10:00'] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const ejecutor = new EjecutorHerramientasHttp({ secretoHmac: 'secreto-de-prueba-largo', fetch: fetchFalso });
    const config = {
      id: 'a',
      perfilId: null,
      identidad: { zonaHoraria: 'America/La_Paz' },
      herramientas: [{ nombre: 'consultar_disponibilidad', tipo: 'http', url: 'https://agenda.ejemplo.com/disp' }],
    } as never;
    const r = await ejecutor.ejecutar('consultar_disponibilidad', { fecha: '2026-09-10' }, { config, conversacionId: 'conv_secreta_0001', canal: 'web', ahora: new Date() });
    expect(r.resultado).toEqual({ libres: ['10:00'] });
    const c = capturado as unknown as { url: string; init: RequestInit };
    expect(c.url).toBe('https://agenda.ejemplo.com/disp');
    const cabeceras = c.init.headers as Record<string, string>;
    expect(cabeceras['x-chatbotrag-firma']).toMatch(/^[a-f0-9]{64}$/);
    expect(String(c.init.body)).not.toContain('conv_secreta_0001');

    const lento = (async (_u: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('abortado'))))) as typeof fetch;
    const impaciente = new EjecutorHerramientasHttp({ secretoHmac: null, tiempoMaximoMs: 20, fetch: lento });
    await expect(impaciente.ejecutar('consultar_disponibilidad', {}, { config, conversacionId: 'conv_secreta_0001', canal: 'web', ahora: new Date() })).rejects.toThrow(/abortado/);
  });
});
