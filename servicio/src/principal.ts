/**
 * PUNTO DE ENTRADA — Cloud Run / contenedor
 *
 * Lee el entorno, arma los agentes (carga corpus), levanta Fastify en 0.0.0.0 y
 * apaga con gracia ante SIGTERM (Cloud Run da 10 s). Un fallo de arranque termina
 * el proceso con código 1 y el detalle en stderr: mejor un despliegue rojo que un
 * servicio que atiende a medias.
 */
import { BitacoraConsola } from '@chatbotrag/nucleo';
import { crearAplicacion } from './aplicacion.js';
import { armarAgentes } from './armar-agentes.js';
import { leerEntorno } from './entorno.js';
import { EjecutorHerramientasHttp } from './herramientas-http.js';

async function principal(): Promise<void> {
  const entorno = leerEntorno();
  const bitacora = new BitacoraConsola();
  const ejecutorExterno = new EjecutorHerramientasHttp({ secretoHmac: entorno.CHATBOTRAG_HMAC_HERRAMIENTAS ?? null });
  const agentes = await armarAgentes(entorno, { bitacora, ejecutorExterno });
  const app = await crearAplicacion({ entorno, agentes });

  const apagar = async (senal: string) => {
    app.log.info({ senal }, 'apagando');
    await app.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void apagar('SIGTERM'));
  process.on('SIGINT', () => void apagar('SIGINT'));

  await app.listen({ port: entorno.PUERTO, host: '0.0.0.0' });
  console.log(JSON.stringify({ en: new Date().toISOString(), tipo: 'servicio_iniciado', puerto: entorno.PUERTO, agentes: [...agentes.keys()] }));
}

principal().catch((e) => {
  console.error(`[chatbotrag] no se pudo iniciar: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
