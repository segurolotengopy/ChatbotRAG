/**
 * APLICACIÓN HTTP (Fastify)
 *
 * Rutas (variante del subset solo-Kuaa; no hay /v1/agente ni /v1/conversaciones/*):
 *   GET    /salud, /health                                 — sin autenticación; sin datos sensibles
 *   POST   /v1/kuaa/mensaje                                — contexto de oportunidad + `mensaje` → salida estructurada
 *                                                            (200 sin clave `ok`: solo las claves de SalidaOportunidad; los errores sí
 *                                                            llevan `ok: false`). Contrato v0.4: el cuerpo admite un bloque opcional
 *                                                            `plataforma`; el esquema es estricto y la ruta no lo registra.
 *
 * AUTENTICACIÓN: `Authorization: Bearer <clave>`. Se compara el SHA-256 de la
 * clave contra los clientes configurados, en tiempo constante. El agente que
 * atiende es el del cliente; el cuerpo no puede elegir otro.
 *
 * LÍMITES: por IP (global) y por cliente (`limitePorMinuto`, ventana fija de 60 s que
 * comparten todos los usuarios de esa clave). El rechazo por límite no consume LLM y
 * el del cliente incluye `Retry-After` (segundos); el del plugin de IP también lo trae. Las cabeceras
 * `x-ratelimit-*` del plugin se refieren a la IP, no al cupo del cliente.
 *
 * ERRORES: 400 forma, 401 sin clave válida, 404 conversación/perfil, 413 texto
 * largo, 429 límite, 500 genérico SIN detalle interno. Ningún error devuelve el
 * texto del usuario.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { EntradaKuaa, ErrorPeticion } from '@chatbotrag/nucleo';
import type { AgenteArmado } from './armar-agentes.js';
import type { Cliente, Entorno } from './entorno.js';

export const VERSION_SERVICIO = '0.1.0';

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
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  await app.register(rateLimit, {
    global: true,
    max: entorno.CHATBOTRAG_LIMITE_IP_MINUTO,
    timeWindow: '1 minute',
    keyGenerator: (p) => p.ip,
    // Sin `statusCode` el plugin lanza este objeto y el manejador de errores lo toma por un 500: con el cupo por IP
    // agotado el servicio respondía ERROR_INTERNO en vez de 429 (y quien reintenta solo ante 429 no reintentaba).
    errorResponseBuilder: () => ({ statusCode: 429, ok: false, motivo: 'LIMITE_EXCEDIDO' }),
  });

  // Cabeceras de seguridad para una API JSON.
  //
  // HSTS y CSP las exige la prueba de humo del pipeline (`exigir_cabeceras`) y
  // faltaban: el primer despliegue real las echó de menos. Tres decisiones:
  //  - HSTS sin `preload`: preload es un compromiso casi irreversible con el
  //    dominio completo, y este servicio vive en un subdominio que no es nuestro
  //    (`*.run.app`). Cloud Run solo sirve HTTPS, así que no cambia el
  //    comportamiento real; deja la política dicha por escrito.
  //  - CSP `default-src 'none'; frame-ancestors 'none'`: una respuesta JSON no
  //    carga ni incrusta nada, así que el valor más estricto no rompe a nadie. El
  //    widget web se sirve aparte (`dist-web/`), no desde este servicio.
  //  - Van en TODA respuesta, también en los errores 401/404/429: la prueba de
  //    humo las mide sobre la raíz, que responde 404.
  // Qué NO garantiza: protege a un navegador que abra la API directamente; no
  // sustituye la autenticación por clave ni la validación de entrada.
  app.addHook('onSend', async (_p, r) => {
    r.header('cache-control', 'no-store');
    r.header('x-content-type-options', 'nosniff');
    r.header('referrer-policy', 'no-referrer');
    r.header('strict-transport-security', 'max-age=31536000; includeSubDomains');
    r.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
  });

  // Cupo por cliente, aparte del cupo por IP. Devuelve null si admite la petición o, si el cupo está agotado, los
  // segundos que faltan para que la ventana de 60 s se renueve (se informan en `Retry-After`).
  const cupoClientes = new Map<string, { inicio: number; n: number }>();
  const admitirCliente = (c: Cliente): number | null => {
    const ahora = Date.now();
    const v = cupoClientes.get(c.id);
    if (!v || ahora - v.inicio >= 60_000) {
      cupoClientes.set(c.id, { inicio: ahora, n: 1 });
      return null;
    }
    if (v.n >= c.limitePorMinuto) return Math.min(60, Math.max(1, Math.ceil((60_000 - (ahora - v.inicio)) / 1000)));
    v.n++;
    return null;
  };

  // La ruta del dominio es `/salud`, como todo lo demás en español. `/health`
  // existe solo como alias hacia la infraestructura: el estándar DevSecOps
  // verifica la salud con `HEALTH_PATH`, cuyo valor por defecto en `deploy.sh`
  // era `/healthz` —que este servicio no sirve— y pasó a `/health`. Además
  // Cloud Run reserva en `*.run.app` las rutas que terminan en «z»: el front
  // end de Google responde su propio 404 y la petición nunca llega al
  // contenedor, así que `/healthz` no funcionaría ni implementándolo.
  // El alias evita depender de que cada operador exporte la variable correcta.
  const salud = async () => ({
    ok: true,
    version: VERSION_SERVICIO,
    agentes: [...agentes.values()].map((a) => ({ id: a.config.id, proveedor: a.proveedor, indice: a.indice.nombre, perfiles: Object.keys(a.config.perfiles).length })),
  });
  app.get('/salud', salud);
  app.get('/health', salud);

  const conCliente = async (p: FastifyRequest): Promise<{ cliente: Cliente; armado: AgenteArmado } | { error: number; motivo: string; reintentarEnS?: number }> => {
    const cliente = autenticar(p, entorno.clientes);
    if (!cliente) return { error: 401, motivo: 'NO_AUTORIZADO' };
    const armado = agentes.get(cliente.agenteId);
    if (!armado) return { error: 500, motivo: 'AGENTE_NO_DISPONIBLE' };
    const espera = admitirCliente(cliente);
    if (espera !== null) return { error: 429, motivo: 'LIMITE_EXCEDIDO', reintentarEnS: espera };
    return { cliente, armado };
  };

  // Respuesta de rechazo de `conCliente`. Con el cupo agotado añade `Retry-After` (segundos) para que quien llama
  // espere y reintente en vez de mostrar un error. No incluye texto del usuario.
  const rechazar = (r: FastifyReply, acceso: { error: number; motivo: string; reintentarEnS?: number }) => {
    if (acceso.reintentarEnS !== undefined) r.header('retry-after', String(acceso.reintentarEnS));
    return r.code(acceso.error).send({ ok: false, motivo: acceso.motivo });
  };

  // Ruta de Kuaa. Misma autenticación, límites y CORS que las demás. Nunca repite en el
  // error los valores recibidos; la respuesta lleva las claves de `SalidaOportunidad` y, solo con perfil `pruebas` y paquete cargado, `validacion` y `version_paquete`.
  app.post('/v1/kuaa/mensaje', async (p, r) => {
    const acceso = await conCliente(p);
    if ('error' in acceso) return rechazar(r, acceso);
    const kuaa = acceso.armado.agenteKuaa;
    if (!kuaa) return r.code(404).send({ ok: false, motivo: 'AGENTE_NO_KUAA' });
    const entrada = EntradaKuaa.safeParse(p.body);
    if (!entrada.success) return r.code(400).send({ ok: false, motivo: 'PETICION_INVALIDA' });
    if (/^#simular:/i.test(entrada.data.mensaje.trim()) && acceso.armado.proveedor !== 'simulado') return r.code(400).send({ ok: false, motivo: 'TEXTO_INVALIDO' });
    try {
      const { salida } = await kuaa.responder(entrada.data, acceso.cliente.id);
      // Solo con perfil `pruebas` y paquete cargado: campos opcionales del SOBRE, fuera de `SalidaOportunidad`.
      if (acceso.armado.perfilConocimiento === 'pruebas' && acceso.armado.versionPaquete) return { ...salida, validacion: 'no_validado', version_paquete: acceso.armado.versionPaquete };
      return salida;
    } catch (e) {
      if (e instanceof ErrorPeticion) return r.code(e.codigo === 'TEXTO_LARGO' ? 413 : 400).send({ ok: false, motivo: e.codigo });
      p.log.error({ err: e instanceof Error ? e.message : String(e) }, 'error no controlado en kuaa');
      return r.code(500).send({ ok: false, motivo: 'ERROR_INTERNO' });
    }
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _p, r) => {
    const status = typeof error.statusCode === 'number' ? error.statusCode : 500;
    if (status >= 500) app.log.error({ err: error.message }, 'error del servidor');
    r.code(status).send({ ok: false, motivo: status === 429 ? 'LIMITE_EXCEDIDO' : status === 413 ? 'CUERPO_LARGO' : status >= 500 ? 'ERROR_INTERNO' : 'PETICION_INVALIDA' });
  });

  app.setNotFoundHandler((_p, r) => r.code(404).send({ ok: false, motivo: 'NO_ENCONTRADO' }));

  return app;
}
