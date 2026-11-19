/**
 * Pruebas de la vía del paquete VALIDADO de Kuaa en el servicio (S2-A). Todo sintético: el lector es una función en
 * memoria; no hay bucket ni red.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BitacoraEnMemoria, EmbebedorSimulado, type LectorPaquete, type ProveedorLLM, type RespuestaLLM } from '@chatbotrag/nucleo';
import { ErrorPaqueteGcs } from '@chatbotrag/conocimiento-gcs';
import { crearAplicacion } from './aplicacion.js';
import { armarAgentes } from './armar-agentes.js';
import { leerEntorno } from './entorno.js';

const CLAVE = 'clave-kuaa-de-prueba-suficientemente-larga';
const hash = (c: string) => createHash('sha256').update(c).digest('hex');
const RUTA_KUAA = fileURLToPath(new URL('../../configuraciones/kuaa.json', import.meta.url));
const MARCA_TEXTO = 'ZORBALEX-VALIDADO';

const sistemas: string[] = [];
const proveedor: ProveedorLLM = {
  nombre: 'guionado',
  async generar(peticion): Promise<RespuestaLLM> {
    sistemas.push(peticion.sistema);
    const texto = JSON.stringify({ texto: 'Te cuento cómo es.', etapa_propuesta: 'E02', objecion: null, botones: [], propuestas: [] });
    return { texto, llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 1, tokensSalida: 1 } };
  },
};

const cuerpo = {
  oportunidad_id: 'op-sintetica-1',
  etapa_actual: 'E02',
  estados: { solicitud: 'desconocido', pago: 'desconocido', aceptacion: 'desconocido', poliza: 'desconocido', documentos: 'desconocido', atencion_humana: 'desconocido' },
  permiso_seguimiento: { vigente: false, canal: 'ninguno' },
  tarifa_version: null,
  pagina: null,
  resumen: { necesidad: 'desconocido', producto: 'desconocido', plan: 'ninguno', objecion_codigo: 'ninguna', objecion_estado: 'ninguna' },
  mensaje: `¿Qué es ${MARCA_TEXTO}?`,
};

const registro = { id: 'r1', pregunta: `¿Qué es ${MARCA_TEXTO}?`, respuesta: `${MARCA_TEXTO} es un concepto sintético validado.`, habilitado_produccion: true, version_paquete: '1.0.0' };

function lectorSintetico(): LectorPaquete & { llamadas: number } {
  const l = {
    llamadas: 0,
    async leerManifiesto() {
      l.llamadas += 1;
      return { version: '1.0.0', archivos: [{ ruta: 'p.json', titular: 'interseguros', sha256: 'a'.repeat(64), bytes: 10 }] };
    },
    async leer() {
      l.llamadas += 1;
      return JSON.stringify([registro]);
    },
  };
  return l;
}

const apps: FastifyInstance[] = [];
const directorios: string[] = [];
afterEach(async () => {
  await Promise.all(directorios.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function levantar(extraEntorno: Record<string, string>, lectorPaqueteValidado?: () => LectorPaquete, opciones: { paqueteHabilitado?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chatbotrag-validado-'));
  directorios.push(dir);
  await mkdir(join(dir, 'corpus'), { recursive: true });
  const config = JSON.parse(readFileSync(RUTA_KUAA, 'utf8')) as { conocimiento: { paquete: { habilitado: boolean } } };
  if (opciones.paqueteHabilitado === false) config.conocimiento.paquete.habilitado = false;
  await writeFile(join(dir, 'kuaa.json'), JSON.stringify(config));
  const entorno = leerEntorno({
    CHATBOTRAG_DIR_CONFIGURACIONES: dir,
    CHATBOTRAG_CLIENTES: JSON.stringify([{ id: 'kuaa-web', agenteId: 'kuaa-segurolotengo', claveSha256: hash(CLAVE) }]),
    CHATBOTRAG_LIMITE_IP_MINUTO: '1000',
    ...extraEntorno,
  });
  const bitacora = new BitacoraEnMemoria();
  const fabrica = () => ({ proveedor, embebedor: new EmbebedorSimulado() });
  const agentes = await armarAgentes(entorno, { bitacora, fabricas: { vertex: fabrica, bedrock: fabrica }, ...(lectorPaqueteValidado ? { lectorPaqueteValidado } : {}) });
  const app = await crearAplicacion({ entorno, agentes, registrar: false });
  apps.push(app);
  const enviar = () => app.inject({ method: 'POST', url: '/v1/kuaa/mensaje', headers: { authorization: `Bearer ${CLAVE}` }, payload: cuerpo });
  return { agentes, bitacora, enviar, armado: agentes.get('kuaa-segurolotengo')! };
}

const VALIDADO = { CHATBOTRAG_PAQUETE_VALIDADO: 'activo', CHATBOTRAG_BUCKET_PAQUETE_VALIDADO: 'bucket-validado', CHATBOTRAG_VERSION_PAQUETE_VALIDADO: '1.0.0', CHATBOTRAG_SHA256_MANIFIESTO_VALIDADO: 'a'.repeat(64) };

describe('paquete validado de Kuaa en el servicio', () => {
  it('con la vía validada responde con las 5 claves y sin respuesta_no_validada', async () => {
    const lector = lectorSintetico();
    const { armado, bitacora, enviar } = await levantar(VALIDADO, () => lector);
    expect(armado.versionPaqueteValidado).toBe('1.0.0');
    expect(armado.versionPaquete).toBeNull();
    expect(await armado.indice.contar('kuaa-segurolotengo--paquete')).toBe(1);
    sistemas.length = 0;
    const r = await enviar();
    expect(r.statusCode).toBe(200);
    expect(sistemas.join('\n')).toContain(`${MARCA_TEXTO} es un concepto sintético validado.`);
    expect(Object.keys(r.json()).sort()).toEqual(['botones', 'etapa_propuesta', 'objecion', 'propuestas', 'texto']);
    expect(bitacora.eventos.map((e) => e.tipo)).not.toContain('respuesta_no_validada');
    expect(bitacora.eventos.find((e) => e.tipo === 'configuracion_cargada')?.detalle).toContain(' paquete_validado=1.0.0');
  });

  it('apagada por defecto no construye el lector', async () => {
    let construido = 0;
    const { armado, bitacora } = await levantar({}, () => {
      construido += 1;
      return lectorSintetico();
    });
    expect(construido).toBe(0);
    expect(armado.versionPaqueteValidado).toBeNull();
    expect(bitacora.eventos.find((e) => e.tipo === 'configuracion_cargada')?.detalle).not.toContain('paquete_validado');
  });

  it('un fallo del lector detiene el arranque con solo el código', async () => {
    const roto: LectorPaquete = {
      async leerManifiesto() {
        throw new ErrorPaqueteGcs('INTEGRIDAD');
      },
      async leer() {
        return '';
      },
    };
    await expect(levantar(VALIDADO, () => roto)).rejects.toThrow('Paquete validado no cargado (INTEGRIDAD)');
    const conDetalle: LectorPaquete = {
      async leerManifiesto() {
        throw new Error(`detalle-con-${MARCA_TEXTO}`);
      },
      async leer() {
        return '';
      },
    };
    const fallo = await levantar(VALIDADO, () => conDetalle).catch((e: unknown) => e as Error);
    expect(fallo.message).toBe('Paquete validado no cargado (ERROR)');
  });

  it('activo con un agente kuaa sin paquete habilitado detiene el arranque antes de leer', async () => {
    const lector = lectorSintetico();
    await expect(levantar(VALIDADO, () => lector, { paqueteHabilitado: false })).rejects.toThrow('no tiene el paquete habilitado');
    expect(lector.llamadas).toBe(0);
  });

  it('la bitácora no contiene el texto del paquete', async () => {
    const { bitacora, enviar } = await levantar(VALIDADO, lectorSintetico);
    await enviar();
    expect(bitacora.eventos.map((e) => e.tipo)).toContain('corpus_indexado');
    expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA_TEXTO);
  });
});
