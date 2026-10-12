/**
 * PRUEBA DE LA SONDA DE STAGING (scripts/sondear-staging.sh)
 *
 * Un monitor que falla en silencio es peor que no tener monitor: la primera versión
 * de la sonda murió con código 1 y sin una línea de salida porque `curl -w` no
 * termina en salto de línea y `read` + `set -e` la mataron. Estas pruebas la
 * ejecutan de verdad contra un servidor local y comprueban las dos direcciones:
 * que pase cuando todo está bien y que FALLE cuando algo se rompe.
 *
 * Qué NO garantiza: no prueba la red de GitHub ni el arranque en frío real de Cloud
 * Run; el umbral de frío se simula con una demora corta y umbrales reducidos.
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./sondear-staging.sh', import.meta.url));
const CABECERAS_SEGURAS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
};

type Manejador = (ruta: string, n: number, res: ServerResponse, req: IncomingMessage) => void;

let servidor: Server | null = null;

/** Respuestas que un manejador tomó a su cargo y contestará más tarde. */
const demoradas = new WeakSet<ServerResponse>();

function responderTarde(res: ServerResponse, ms: number): void {
  demoradas.add(res);
  setTimeout(() => {
    res.writeHead(200, { 'content-type': 'application/json', ...CABECERAS_SEGURAS });
    res.end('{"ok":true}');
  }, ms);
}

/** Servidor que se comporta como un servicio sano, con ganchos para romperlo. */
async function levantar(personalizado?: Manejador): Promise<string> {
  const llamadas = new Map<string, number>();
  servidor = createServer((req, res) => {
    const ruta = (req.url ?? '/').split('?')[0] ?? '/';
    const n = (llamadas.get(ruta) ?? 0) + 1;
    llamadas.set(ruta, n);
    if (personalizado) {
      personalizado(ruta, n, res, req);
      if (res.writableEnded || res.headersSent || demoradas.has(res)) return;
    }
    if (ruta === '/salud' || ruta === '/health') {
      res.writeHead(200, { 'content-type': 'application/json', ...CABECERAS_SEGURAS });
      res.end('{"ok":true,"version":"0.1.0"}');
    } else if (ruta === '/v1/agente') {
      res.writeHead(401, { 'content-type': 'application/json', ...CABECERAS_SEGURAS });
      res.end('{"ok":false,"motivo":"NO_AUTORIZADO"}');
    } else {
      res.writeHead(404, CABECERAS_SEGURAS);
      res.end();
    }
  });
  await new Promise<void>((ok) => servidor!.listen(0, '127.0.0.1', ok));
  return `http://127.0.0.1:${(servidor!.address() as AddressInfo).port}`;
}

afterEach(async () => {
  if (servidor) await new Promise<void>((ok) => servidor!.close(() => ok()));
  servidor = null;
});

interface Resultado {
  codigo: number;
  salida: string;
}

function sondear(url: string, extra: Record<string, string> = {}): Promise<Resultado> {
  return new Promise((resolver) => {
    execFile(
      'bash',
      [SCRIPT],
      { env: { PATH: process.env['PATH'] ?? '', URL_STAGING: url, SONDA_PRUEBAS: '1', REINTENTOS: '1', ESPERA_REINTENTO_SEG: '0', ...extra } },
      (err, stdout, stderr) => {
        const codigo = err ? ((err as NodeJS.ErrnoException & { code?: number }).code as number | undefined) ?? 1 : 0;
        resolver({ codigo: typeof codigo === 'number' ? codigo : 1, salida: `${stdout}${stderr}` });
      },
    );
  });
}

describe('sonda de staging', () => {
  it('pasa y deja un resumen cuando el servicio está sano', async () => {
    const r = await sondear(await levantar());
    expect(r.codigo).toBe(0);
    expect(r.salida).toContain('**OK**');
  });

  it('falla si /salud no responde 200', async () => {
    const r = await sondear(await levantar((ruta, _n, res) => ruta === '/salud' && (res.writeHead(500), res.end())));
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('/salud respondió 500');
  });

  it('falla si el cuerpo de /salud no trae "ok":true', async () => {
    const r = await sondear(
      await levantar((ruta, _n, res) => {
        if (ruta === '/salud') {
          res.writeHead(200, CABECERAS_SEGURAS);
          res.end('{"ok":false}');
        }
      }),
    );
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('"ok":true');
  });

  it('falla si falta HSTS', async () => {
    const r = await sondear(
      await levantar((ruta, _n, res) => {
        if (ruta === '/salud') {
          res.writeHead(200, { 'content-security-policy': "default-src 'none'" });
          res.end('{"ok":true}');
        }
      }),
    );
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('HSTS');
  });

  it('falla si falta CSP', async () => {
    const r = await sondear(
      await levantar((ruta, _n, res) => {
        if (ruta === '/salud') {
          res.writeHead(200, { 'strict-transport-security': 'max-age=1' });
          res.end('{"ok":true}');
        }
      }),
    );
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('CSP');
  });

  it('falla si /health no responde 200', async () => {
    const r = await sondear(await levantar((ruta, _n, res) => ruta === '/health' && (res.writeHead(404), res.end())));
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('/health respondió 404');
  });

  it('falla si /v1/agente sin clave deja de responder 401 (control de acceso abierto)', async () => {
    const r = await sondear(
      await levantar((ruta, _n, res) => {
        if (ruta === '/v1/agente') {
          res.writeHead(200, CABECERAS_SEGURAS);
          res.end('{"ok":true}');
        }
      }),
    );
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('debía responder 401');
  });

  it('falla si el servicio no responde (puerto cerrado)', async () => {
    const url = await levantar();
    await new Promise<void>((ok) => servidor!.close(() => ok()));
    servidor = null;
    const r = await sondear(url, { TIMEOUT_SEG: '2' });
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('000');
  });

  it('descarta la primera llamada lenta como arranque en frío y mide la segunda', async () => {
    const r = await sondear(
      await levantar((ruta, n, res) => {
        if (ruta === '/salud' && n === 1) responderTarde(res, 1300);
      }),
      { UMBRAL_FRIO_SEG: '1', AVISO_LATENCIA_SEG: '5', LIMITE_FALLO_SEG: '10' },
    );
    expect(r.codigo).toBe(0);
    expect(r.salida).toContain('arranque en frío');
  });

  it('falla si la segunda llamada también es lenta', async () => {
    const r = await sondear(
      await levantar((ruta, _n, res) => {
        if (ruta === '/salud') responderTarde(res, 1300);
      }),
      { UMBRAL_FRIO_SEG: '1', LIMITE_FALLO_SEG: '1.2' },
    );
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('por encima del límite');
  });

  it('una falla puntual se reintenta y no declara incidente', async () => {
    const r = await sondear(
      await levantar((ruta, n, res) => ruta === '/salud' && n === 1 && (res.writeHead(503), res.end())),
      { REINTENTOS: '3' },
    );
    expect(r.codigo).toBe(0);
    expect(r.salida).toContain('2 intento(s)');
  });

  it.each(['', 'http://example.com', 'https://host.example/ruta', 'https://host.example/', 'ftp://host', 'https://a.b;rm -rf'])(
    'rechaza con código 2 la URL inválida «%s»',
    async (url) => {
      const r = await sondear(url, { SONDA_PRUEBAS: '0' });
      expect(r.codigo).toBe(2);
      expect(r.salida).toContain('forma inválida');
    },
  );
});
