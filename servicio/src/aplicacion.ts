/**
 * APLICACIÓN HTTP (Fastify)
 *
 * Rutas:
 *   GET    /salud                                          — sin autenticación; sin datos sensibles
 *   GET    /v1/agente                                      — perfiles y bienvenida del agente del cliente
 *   POST   /v1/conversaciones/:conversacionId/mensajes     — { perfilId?, texto, canal? }
 *   DELETE /v1/conversaciones/:conversacionId              — olvidar la conversación
 *
 * AUTENTICACIÓN: `Authorization: Bearer <clave>`. Se compara el SHA-256 de la
 * clave contra los clientes configurados, en tiempo constante. El agente que
 * atiende es el del cliente; el cuerpo no puede elegir otro.
 *
 * LÍMITES: por IP (global) y por cliente (`limitePorMinuto`), ventana deslizante
 * del plugin. El rechazo por límite no consume LLM.
 *
 * ERRORES: 400 forma, 401 sin clave válida, 404 conversación/perfil, 413 texto
 * largo, 429 límite, 500 genérico SIN detalle interno. Ningún error devuelve el
 * texto del usuario.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ErrorPeticion, esIdConversacionValido, listarPerfiles, resolverConfiguracion } from '@chatbotrag/nucleo';
import type { AgenteArmado } from './armar-agentes.js';
import type { Cliente, Entorno } from './entorno.js';

export const VERSION_SERVICIO = '0.1.0';

interface CuerpoMensaje {
  perfilId?: string | null;
  texto?: unknown;
  canal?: unknown;
}

function sha256(texto: string): Buffer {
  return createHash('sha256').update(texto).digest();
}

export function autenticar(peticion: FastifyRequest, clientes: Cliente[]): Cliente | null {
  const cabecera = peticion.headers.authorization;
  if (!cabecera || !cabecera.startsWith('Bearer ')) return null;
  const clave = cabecera.slice(7).trim();
  if (clave.length < 16 || clave.length > 256) return null;
  const hash = sha256(clave);
  for (const c of clientes) {
    const esperado = Buffer.from(c.claveSha256, 'hex');
    if (esperado.length === hash.length && timingSafeEqual(esperado, hash)) return c;
  }
  return null;
}

export interface OpcionesAplicacion {
  entorno: Entorno;
  agentes: Map<string, AgenteArmado>;
  registrar?: boolean;
}

export async function crearAplicacion(opciones: OpcionesAplicacion): Promise<FastifyInstance> {
  const { entorno, agentes } = opciones;
  const app = Fastify({
    logger: opciones.registrar === false ? false : { level: entorno.NODE_ENV === 'production' ? 'info' : 'warn', redact: ['req.headers.authorization'] },
    bodyLimit: 32 * 1024,
    trustProxy: true,
    disableRequestLogging: true, // la bitácora del núcleo ya registra lo necesario, sin texto
  });

  const origenes = new Set(entorno.clientes.flatMap((c) => c.origenes));
  await app.register(cors, {
    origin: (origen, cb) => cb(null, !origen || origenes.has(origen)),
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  await app.register(rateLimit, {
    global: true,
    max: entorno.CHATBOTRAG_LIMITE_IP_MINUTO,
    timeWindow: '1 minute',
    keyGenerator: (p) => p.ip,
    errorResponseBuilder: () => ({ ok: false, motivo: 'LIMITE_EXCEDIDO' }),
  });

  // Cabeceras de seguridad mínimas para una API JSON.
  app.addHook('onSend', async (_p, r) => {
    r.header('cache-control', 'no-store');
    r.header('x-content-type-options', 'nosniff');
    r.header('referrer-policy', 'no-referrer');
  });

  // Cupo por cliente, aparte del cupo por IP.
  const cupoClientes = new Map<string, { inicio: number; n: number }>();
  const admitirCliente = (c: Cliente): boolean => {
    const ahora = Date.now();
    const v = cupoClientes.get(c.id);
    if (!v || ahora - v.inicio >= 60_000) {
      cupoClientes.set(c.id, { inicio: ahora, n: 1 });
      return true;
    }
    if (v.n >= c.limitePorMinuto) return false;
    v.n++;
    return true;
  };

  app.get('/salud', async () => ({
    ok: true,
    version: VERSION_SERVICIO,
    agentes: [...agentes.values()].map((a) => ({ id: a.config.id, proveedor: a.proveedor, indice: a.indice.nombre, perfiles: Object.keys(a.config.perfiles).length })),
  }));

  const conCliente = async (p: FastifyRequest): Promise<{ cliente: Cliente; armado: AgenteArmado } | { error: number; motivo: string }> => {
    const cliente = autenticar(p, entorno.clientes);
    if (!cliente) return { error: 401, motivo: 'NO_AUTORIZADO' };
    const armado = agentes.get(cliente.agenteId);
    if (!armado) return { error: 500, motivo: 'AGENTE_NO_DISPONIBLE' };
    if (!admitirCliente(cliente)) return { error: 429, motivo: 'LIMITE_EXCEDIDO' };
    return { cliente, armado };
  };

  app.get('/v1/agente', async (p, r) => {
    const acceso = await conCliente(p);
    if ('error' in acceso) return r.code(acceso.error).send({ ok: false, motivo: acceso.motivo });
    const { config } = acceso.armado;
    const perfiles = listarPerfiles(config).map((perfil) => ({ ...perfil, bienvenida: resolverConfiguracion(config, perfil.id).mensajes.bienvenida }));
    return {
      ok: true,
      agente: { id: config.id, nombreAsistente: config.identidad.nombreAsistente, organizacion: config.identidad.organizacion, idioma: config.identidad.idioma },
      perfilPorDefecto: config.perfilPorDefecto ?? null,
      perfiles,
      bienvenida: config.mensajes.bienvenida,
      maxCaracteresEntrada: config.seguridad.maxCaracteresEntrada,
    };
  });

  app.post<{ Params: { conversacionId: string }; Body: CuerpoMensaje }>('/v1/conversaciones/:conversacionId/mensajes', async (p, r) => {
    const acceso = await conCliente(p);
    if ('error' in acceso) return r.code(acceso.error).send({ ok: false, motivo: acceso.motivo });
    const { conversacionId } = p.params;
    if (!esIdConversacionValido(conversacionId)) return r.code(400).send({ ok: false, motivo: 'CONVERSACION_INVALIDA' });
    const cuerpo = (p.body ?? {}) as CuerpoMensaje;
    if (typeof cuerpo.texto !== 'string') return r.code(400).send({ ok: false, motivo: 'TEXTO_REQUERIDO' });
    if (/^#simular:/i.test(cuerpo.texto.trim()) && acceso.armado.proveedor !== 'simulado') return r.code(400).send({ ok: false, motivo: 'TEXTO_INVALIDO' });
    const canal = typeof cuerpo.canal === 'string' && /^[a-z]{2,20}$/.test(cuerpo.canal) ? cuerpo.canal : 'web';
    const perfilId = typeof cuerpo.perfilId === 'string' && cuerpo.perfilId.length <= 60 ? cuerpo.perfilId : null;

    try {
      const respuesta = await acceso.armado.agente.responder({ conversacionId, perfilId, texto: cuerpo.texto, canal });
      return { ok: true, ...respuesta };
    } catch (e) {
      if (e instanceof ErrorPeticion) {
        const codigo = e.codigo === 'TEXTO_LARGO' ? 413 : e.codigo === 'PERFIL_DESCONOCIDO' ? 404 : 400;
        return r.code(codigo).send({ ok: false, motivo: e.codigo });
      }
      p.log.error({ err: e instanceof Error ? e.message : String(e) }, 'error no controlado al responder');
      return r.code(500).send({ ok: false, motivo: 'ERROR_INTERNO' });
    }
  });

  app.delete<{ Params: { conversacionId: string } }>('/v1/conversaciones/:conversacionId', async (p, r) => {
    const acceso = await conCliente(p);
    if ('error' in acceso) return r.code(acceso.error).send({ ok: false, motivo: acceso.motivo });
    if (!esIdConversacionValido(p.params.conversacionId)) return r.code(400).send({ ok: false, motivo: 'CONVERSACION_INVALIDA' });
    await acceso.armado.memoria.olvidar(p.params.conversacionId);
    return r.code(204).send();
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _p, r) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) app.log.error({ err: error.message }, 'error del servidor');
    r.code(status).send({ ok: false, motivo: status === 429 ? 'LIMITE_EXCEDIDO' : status === 413 ? 'CUERPO_LARGO' : status >= 500 ? 'ERROR_INTERNO' : 'PETICION_INVALIDA' });
  });

  app.setNotFoundHandler((_p, r) => r.code(404).send({ ok: false, motivo: 'NO_ENCONTRADO' }));

  return app;
}
