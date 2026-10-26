/**
 * Pruebas de la carga del paquete no validado de Kuaa en el servicio (K3b). Todo sintético: el lector del
 * paquete es una función en memoria; no hay bucket ni red.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { BitacoraEnMemoria, EmbebedorSimulado, IndiceEnMemoria, type LectorPaquete, type PeticionLLM, type ProveedorLLM, type RespuestaLLM } from '@chatbotrag/nucleo';
import { ErrorPaqueteGcs } from '@chatbotrag/conocimiento-gcs';
import { crearAplicacion } from './aplicacion.js';
import { armarAgentes } from './armar-agentes.js';
import { leerEntorno } from './entorno.js';

// El lector por omisión se reemplaza por uno que siempre responde 403 (sin red) y anota con qué se construyó.
const construidos = vi.hoisted(() => [] as Array<{ bucket: string; version: string }>);
vi.mock('@chatbotrag/conocimiento-gcs', async (original) => {
  const real = await original<{ ErrorPaqueteGcs: typeof ErrorPaqueteGcs }>();
  return {
    ...real,
    LectorPaqueteGcs: class {
      constructor(opciones: { bucket: string; version: string }) {
        construidos.push(opciones);
      }
      async leerManifiesto(): Promise<never> {
        throw new real.ErrorPaqueteGcs('NO_AUTORIZADO');
      }
      async leer(): Promise<never> {
        throw new real.ErrorPaqueteGcs('NO_AUTORIZADO');
      }
    },
  };
});

const CLAVE = 'clave-kuaa-de-prueba-suficientemente-larga';
const hash = (c: string) => createHash('sha256').update(c).digest('hex');
const RUTA_KUAA = fileURLToPath(new URL('../../configuraciones/kuaa.json', import.meta.url));
const MARCA_TEXTO = 'ZORBALEX-SINTETICO';

const vistas: PeticionLLM[] = [];
const proveedor: ProveedorLLM = {
  nombre: 'guionado',
  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    vistas.push(p);
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

const registro = { id: 'r1', pregunta: `¿Qué es ${MARCA_TEXTO}?`, respuesta: `${MARCA_TEXTO} es un concepto sintético de prueba.`, habilitado_produccion: false, validacion: 'no_validado', version_paquete: '1.0.0' };

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
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

async function levantar(extraEntorno: Record<string, string>, lectorPaquete?: () => LectorPaquete, extra: { corpusPublico?: boolean; pool?: unknown } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chatbotrag-paquete-'));
  await mkdir(join(dir, 'corpus'), { recursive: true });
  const config = JSON.parse(readFileSync(RUTA_KUAA, 'utf8')) as { conocimiento: Record<string, unknown> };
  if (extra.corpusPublico) {
    config.conocimiento['fuentes'] = [{ id: 'doc', titulo: 'Documento público sintético', version: 'v1', ruta: 'doc.md' }];
    await writeFile(join(dir, 'corpus', 'doc.md'), '# Proceso\n\nEl proceso público tiene cuatro pasos sintéticos.');
  }
  await writeFile(join(dir, 'kuaa.json'), JSON.stringify(config));
  const entorno = leerEntorno({
    CHATBOTRAG_DIR_CONFIGURACIONES: dir,
    CHATBOTRAG_CLIENTES: JSON.stringify([{ id: 'kuaa-web', agenteId: 'kuaa-segurolotengo', claveSha256: hash(CLAVE) }]),
    CHATBOTRAG_LIMITE_IP_MINUTO: '1000',
    ...extraEntorno,
  });
  const bitacora = new BitacoraEnMemoria();
  const fabrica = () => ({ proveedor, embebedor: new EmbebedorSimulado() });
  const agentes = await armarAgentes(entorno, { bitacora, fabricas: { vertex: fabrica, bedrock: fabrica }, ...(lectorPaquete ? { lectorPaquete } : {}), ...(extra.pool ? { pool: extra.pool as never } : {}) });
  const app = await crearAplicacion({ entorno, agentes, registrar: false });
  apps.push(app);
  const enviar = () => app.inject({ method: 'POST', url: '/v1/kuaa/mensaje', headers: { authorization: `Bearer ${CLAVE}` }, payload: cuerpo });
  return { agentes, bitacora, enviar, armado: agentes.get('kuaa-segurolotengo')! };
}

const PRUEBAS = { CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' };

describe('paquete no validado de Kuaa en el servicio', () => {
  it('con perfil pruebas carga el paquete, lo marca y lo hace visible en la respuesta', async () => {
    vistas.length = 0;
    const lector = lectorSintetico();
    const { armado, bitacora, enviar } = await levantar(PRUEBAS, () => lector);
    expect(armado.versionPaquete).toBe('1.0.0');
    expect(await armado.indice.contar('kuaa-segurolotengo--paquete')).toBe(1);
    expect(await armado.indice.contar('kuaa-segurolotengo')).toBe(0);
    const r = await enviar();
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ validacion: 'no_validado', version_paquete: '1.0.0' });
    expect(vistas.at(-1)!.sistema).toContain(MARCA_TEXTO);
    const tipos = bitacora.eventos.map((e) => e.tipo);
    expect(tipos).toContain('respuesta_no_validada');
    const carga = bitacora.eventos.find((e) => e.tipo === 'configuracion_cargada');
    expect(carga?.detalle).toContain('perfil_conocimiento=pruebas paquete=1.0.0 fragmentos_paquete=1');
    expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA_TEXTO);
  });

  it('con perfil produccion (variable ausente) no construye ni llama al lector y no hay fragmentos ni campos de validación', async () => {
    vistas.length = 0;
    const lector = lectorSintetico();
    let construido = 0;
    const { armado, enviar } = await levantar({}, () => {
      construido += 1;
      return lector;
    });
    expect(construido).toBe(0);
    expect(lector.llamadas).toBe(0);
    expect(armado.perfilConocimiento).toBe('produccion');
    expect(armado.versionPaquete).toBeNull();
    expect(await armado.indice.contar('kuaa-segurolotengo')).toBe(0);
    const r = await enviar();
    expect(r.statusCode).toBe(200);
    expect(Object.keys(r.json()).sort()).toEqual(['botones', 'etapa_propuesta', 'objecion', 'propuestas', 'texto']);
  });

  it('con perfil produccion un fragmento marcado que llegue al índice se descarta antes del prompt', async () => {
    vistas.length = 0;
    const { armado, bitacora, enviar } = await levantar({}, lectorSintetico);
    await armado.indice.indexar([
      { id: 'f1', coleccion: 'kuaa-segurolotengo', fuenteId: 'x', fuenteTitulo: 'x', fuenteVersion: '1.0.0', orden: 0, texto: `${MARCA_TEXTO} es un concepto sintético.`, validacion: 'no_validado', versionPaquete: '1.0.0' },
    ]);
    const r = await enviar();
    expect(r.json()).not.toHaveProperty('validacion');
    // Sin el fragmento no hay respaldo: el modelo ni siquiera recibe el texto marcado.
    expect(vistas.at(-1)!.sistema).not.toContain(`${MARCA_TEXTO} es un concepto`);
    expect(bitacora.eventos.map((e) => e.tipo)).toContain('sin_respaldo');
    expect(bitacora.eventos.map((e) => e.tipo)).not.toContain('respuesta_no_validada');
  });

  it('si el bucket falla, el servicio arranca con 0 fragmentos y deja el evento paquete_no_cargado', async () => {
    const roto: LectorPaquete = {
      async leerManifiesto() {
        throw new ErrorPaqueteGcs('NO_AUTORIZADO');
      },
      async leer() {
        return '';
      },
    };
    const { armado, bitacora, enviar } = await levantar(PRUEBAS, () => roto);
    expect(armado.versionPaquete).toBeNull();
    expect(await armado.indice.contar('kuaa-segurolotengo')).toBe(0);
    expect(bitacora.eventos.find((e) => e.tipo === 'paquete_no_cargado')).toMatchObject({ codigo: 'NO_AUTORIZADO' });
    const r = await enviar();
    expect(r.statusCode).toBe(200);
    expect(r.json()).not.toHaveProperty('validacion');
  });

  it('un error de construcción del lector también se contiene y solo registra el código', async () => {
    const { armado, bitacora } = await levantar(PRUEBAS, () => {
      throw new Error(`detalle-con-${MARCA_TEXTO}`);
    });
    expect(armado.versionPaquete).toBeNull();
    expect(bitacora.eventos.find((e) => e.tipo === 'paquete_no_cargado')).toMatchObject({ codigo: 'ERROR' });
    expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA_TEXTO);
  });

  it('sin lector inyectado usa el de GCS y un 403 deja el arranque en pie con paquete_no_cargado', async () => {
    const { armado, bitacora } = await levantar(PRUEBAS);
    expect(construidos).toEqual([{ bucket: 'bucket-sintetico', version: '1.0.0' }]);
    expect(armado.versionPaquete).toBeNull();
    expect(bitacora.eventos.find((e) => e.tipo === 'paquete_no_cargado')).toMatchObject({ codigo: 'NO_AUTORIZADO' });
  });

  it('un fallo a mitad de la carga con corpus público presente deja el corpus público intacto y vacía solo el paquete', async () => {
    const lector = lectorSintetico();
    const roto: LectorPaquete = {
      leerManifiesto: () => lector.leerManifiesto(),
      async leer() {
        throw new ErrorPaqueteGcs('INTEGRIDAD');
      },
    };
    const { armado, bitacora } = await levantar(PRUEBAS, () => roto, { corpusPublico: true });
    expect(await armado.indice.contar('kuaa-segurolotengo')).toBeGreaterThan(0);
    expect(await armado.indice.contar('kuaa-segurolotengo--paquete')).toBe(0);
    expect(bitacora.eventos.find((e) => e.tipo === 'paquete_no_cargado')).toMatchObject({ codigo: 'INTEGRIDAD' });
  });

  it('si vaciar la colección del paquete también falla, el arranque sigue y solo vacía esa colección', async () => {
    const vaciadas: string[] = [];
    const original = IndiceEnMemoria.prototype.vaciar;
    const espia = vi.spyOn(IndiceEnMemoria.prototype, 'vaciar').mockImplementation(async function (this: IndiceEnMemoria, coleccion: string) {
      vaciadas.push(coleccion);
      if (coleccion.endsWith('--paquete')) throw new Error('vaciar falla');
      return original.call(this, coleccion);
    });
    try {
      const roto: LectorPaquete = { leerManifiesto: async () => { throw new ErrorPaqueteGcs('ERROR'); }, leer: async () => '' };
      const { armado, bitacora } = await levantar(PRUEBAS, () => roto, { corpusPublico: true });
      expect(armado.versionPaquete).toBeNull();
      expect(bitacora.eventos.find((e) => e.tipo === 'paquete_no_cargado')).toBeDefined();
      expect(vaciadas).toContain('kuaa-segurolotengo--paquete');
      expect(await armado.indice.contar('kuaa-segurolotengo')).toBeGreaterThan(0);
    } finally {
      espia.mockRestore();
    }
  });

  it('con pgvector y perfil pruebas no se lee el bucket ni se toca el índice: PGVECTOR_NO_ADMITE', async () => {
    const consultas: string[] = [];
    const pool = { async query(sql: string) { consultas.push(sql); return { rows: [] }; } };
    const lector = lectorSintetico();
    const { armado, bitacora } = await levantar({ ...PRUEBAS, CHATBOTRAG_INDICE: 'pgvector', PGVECTOR_URL: 'postgres://u:p@localhost:5432/d' }, () => lector, { pool });
    expect(lector.llamadas).toBe(0);
    expect(armado.versionPaquete).toBeNull();
    expect(bitacora.eventos.find((e) => e.tipo === 'paquete_no_cargado')).toMatchObject({ codigo: 'PGVECTOR_NO_ADMITE' });
    expect(consultas.some((c) => c.includes('paquete'))).toBe(false);
  });

  it('un registro true dentro del paquete no llega al índice ni a la respuesta', async () => {
    const lector = lectorSintetico();
    const conTrue: LectorPaquete = { leerManifiesto: () => lector.leerManifiesto(), leer: async () => JSON.stringify([{ ...registro, habilitado_produccion: true }]) };
    const { armado } = await levantar(PRUEBAS, () => conTrue);
    expect(await armado.indice.contar('kuaa-segurolotengo--paquete')).toBe(0);
  });
});
