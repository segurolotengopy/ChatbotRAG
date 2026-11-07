/**
 * Pruebas de integración del enrutador conectado a Kuaa (H4d) por `POST /v1/kuaa/mensaje`: el banco y la calibración salen de un
 * cliente de objetos en memoria (con el lector real, que verifica las huellas) y el embebedor es una tabla sintética. Sin
 * bucket, sin Vertex y sin red.
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BitacoraEnMemoria, VERSION_REGLA_DECISION, type Embebedor, type PeticionLLM, type ProveedorLLM, type RespuestaLLM } from '@chatbotrag/nucleo';
import { LectorBancoGcs, type ClienteObjetos } from '@chatbotrag/conocimiento-gcs';
import { crearAplicacion } from './aplicacion.js';
import { armarAgentes, type LectorBanco } from './armar-agentes.js';
import { leerEntorno } from './entorno.js';

const RUTA_KUAA = fileURLToPath(new URL('../../configuraciones/kuaa.json', import.meta.url));
const AGENTE = 'kuaa-segurolotengo';
const CLAVE = 'clave-kuaa-de-prueba-suficientemente-larga';
const hash = (c: string) => createHash('sha256').update(c).digest('hex');
const MARCA = 'ZORBALEX-MENSAJE';
const TEXTO_SINIESTRO = '(ejemplo) Texto sintético de derivación por siniestro.';
const TEXTO_EMERGENCIA = '(ejemplo) Texto sintético de derivación por emergencia.';

const BANCO = JSON.stringify({
  formato: 1,
  version: '1.0.0',
  descripcion: 'Banco SINTÉTICO de pruebas de H4d.',
  respuestas: [{ id: 'r-contacto', tema: 'contacto', preguntas: ['pregunta sintetica de contacto'], plantilla: '(ejemplo) Texto sintético de contacto.', aprobado_por: 'ejemplo sintetico', riesgo: 'normal' }],
  derivaciones: [
    { id: 'd-siniestro', motivo: 'siniestro_particular', preguntas: ['pregunta sintetica de siniestro'], texto: TEXTO_SINIESTRO, aprobado_por: 'ejemplo sintetico' },
    { id: 'd-emergencia', motivo: 'emergencia', terminos: ['termino emergencia ejemplo'], texto: TEXTO_EMERGENCIA, aprobado_por: 'ejemplo sintetico' },
  ],
});
const SHA_BANCO = hash(BANCO);
const CALIBRACION = JSON.stringify({
  formato: 1,
  regla: VERSION_REGLA_DECISION,
  banco_sha256: SHA_BANCO,
  evaluacion_sha256: 'b'.repeat(64),
  proveedor: 'vertex',
  modelo: 'modelo-prueba',
  dimension: 4,
  umbral_fijo: 0.8,
  umbral_derivacion: 0.7,
  margen: 0.1,
  valido: true,
  motivos_invalidez: [],
  control: { total: 100, confusiones: 0, falsos_positivos: 0 },
  medido: '2026-11-05',
});

class EmbebedorTabla implements Embebedor {
  nombre = 'modelo-prueba';
  dimension = 4;
  lotes: string[][] = [];
  falla = false;
  /** Errores que se lanzan, en orden, en las primeras llamadas (antes de empezar a responder bien). */
  fallasIniciales: unknown[] = [];
  async embeber(textos: string[]): Promise<number[][]> {
    this.lotes.push([...textos]);
    if (this.fallasIniciales.length > 0) throw this.fallasIniciales.shift();
    if (this.fallasCuota > 0) {
      this.fallasCuota -= 1;
      throw Object.assign(new Error('cuota'), { causa: 'cuota' });
    }
    if (this.falla) throw new Error('embebedor caído');
    return textos.map((t) => {
      const v = [0, 0, 0, 0];
      v[t.includes('siniestro') ? 0 : t.includes('contacto') ? 1 : 3] = 1;
      return v;
    });
  }
}

const cliente: ClienteObjetos = {
  async metadatos(ruta) {
    return { tamano: Buffer.byteLength(ruta.endsWith('banco.json') ? BANCO : CALIBRACION), generacion: 'g' };
  },
  async descargar(ruta) {
    return Buffer.from(ruta.endsWith('banco.json') ? BANCO : CALIBRACION);
  },
};

const directorios: string[] = [];
afterEach(async () => {
  await Promise.all(directorios.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function levantar(extra: Record<string, string>, opciones: { shaBanco?: string; embebedor?: EmbebedorTabla; carrilFijo?: boolean; esperar?: (ms: number) => Promise<void> } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chatbotrag-enrutador-'));
  directorios.push(dir);
  const config = JSON.parse(readFileSync(RUTA_KUAA, 'utf8')) as { enrutador: { activo: boolean; carrilFijo: boolean } };
  config.enrutador = { activo: true, carrilFijo: opciones.carrilFijo ?? false };
  await writeFile(join(dir, 'kuaa.json'), JSON.stringify(config));
  const entorno = leerEntorno({
    CHATBOTRAG_DIR_CONFIGURACIONES: dir,
    CHATBOTRAG_CLIENTES: JSON.stringify([{ id: 'kuaa-web', agenteId: AGENTE, claveSha256: hash(CLAVE) }]),
    CHATBOTRAG_LIMITE_IP_MINUTO: '1000',
    APP_ENV: 'test',
    CHATBOTRAG_BUCKET_BANCO: 'bucket-banco',
    CHATBOTRAG_BANCOS: JSON.stringify({ [AGENTE]: { version: '1.0.0', sha256: opciones.shaBanco ?? SHA_BANCO, sha256Calibracion: hash(CALIBRACION) } }),
    ...extra,
  });
  const vistas: PeticionLLM[] = [];
  const proveedor: ProveedorLLM = {
    nombre: 'guionado',
    async generar(p: PeticionLLM): Promise<RespuestaLLM> {
      vistas.push(p);
      const texto = JSON.stringify({ texto: 'Te cuento lo que sé del proceso. ¿Seguimos?', etapa_propuesta: 'E02', objecion: null, botones: [], propuestas: [] });
      return { texto, llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 1, tokensSalida: 1 } };
    },
  };
  const embebedor = opciones.embebedor ?? new EmbebedorTabla();
  const bitacora = new BitacoraEnMemoria();
  const fabrica = () => ({ proveedor, embebedor });
  const agentes = await armarAgentes(entorno, { bitacora, fabricas: { vertex: fabrica, bedrock: fabrica }, lectorBanco: () => new LectorBancoGcs({ bucket: 'b', cliente }) as LectorBanco, ...(opciones.esperar ? { esperar: opciones.esperar } : {}) });
  const app = await crearAplicacion({ entorno, agentes, registrar: false });
  const enviar = (mensaje: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/kuaa/mensaje',
      headers: { authorization: `Bearer ${CLAVE}` },
      payload: {
        oportunidad_id: 'op-sintetica-1',
        etapa_actual: 'E02',
        estados: { solicitud: 'desconocido', pago: 'desconocido', aceptacion: 'desconocido', poliza: 'desconocido', documentos: 'desconocido', atencion_humana: 'desconocido' },
        permiso_seguimiento: { vigente: false, canal: 'ninguno' },
        tarifa_version: null,
        pagina: null,
        resumen: { necesidad: 'desconocido', producto: 'desconocido', plan: 'ninguno', objecion_codigo: 'ninguna', objecion_estado: 'ninguna' },
        mensaje,
      },
    });
  return { app, enviar, vistas, bitacora, embebedor };
}

describe('Kuaa con el enrutador encendido por el ambiente (POST /v1/kuaa/mensaje)', () => {
  it('derivación exacta: texto sintético del banco y el modelo no se llama', async () => {
    const { app, enviar, vistas, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' });
    const r = await enviar('termino emergencia ejemplo');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ texto: TEXTO_EMERGENCIA, propuestas: ['atencion_humana_solicitada'], botones: [] });
    expect(vistas).toHaveLength(0);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toBe('calibracion=si semantica=si enrutador=activo');
    await app.close();
  });

  it('derivación semántica: texto sintético, una llamada de embedding por mensaje y el modelo no se llama', async () => {
    const { app, enviar, vistas, embebedor, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' });
    embebedor.lotes.length = 0;
    const r = await enviar(`consulta sobre siniestro ${MARCA}`);
    expect(r.json().texto).toBe(TEXTO_SINIESTRO);
    expect(vistas).toHaveLength(0);
    expect(embebedor.lotes.filter((l) => l.length === 1 && l[0]?.includes(MARCA))).toHaveLength(1);
    expect(bitacora.eventos.find((e) => e.tipo === 'enrutador')).toMatchObject({ carril: 'derivacion', via: 'semantica' });
    expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA);
    await app.close();
  });

  it('un mensaje sin relación sigue por la IA, con una sola llamada de embedding compartida con el RAG', async () => {
    const { app, enviar, vistas, embebedor } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' });
    embebedor.lotes.length = 0;
    const r = await enviar(`¿Cómo es el proceso? ${MARCA}`);
    expect(r.statusCode).toBe(200);
    expect(vistas).toHaveLength(1);
    expect(embebedor.lotes.filter((l) => l.length === 1 && l[0]?.includes(MARCA))).toHaveLength(1);
    await app.close();
  });

  it('SHA del banco equivocado: el banco no carga y la respuesta es la de siempre', async () => {
    const { app, enviar, vistas, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { shaBanco: 'a'.repeat(64) });
    const r = await enviar('termino emergencia ejemplo');
    expect(r.statusCode).toBe(200);
    expect(r.json().texto).not.toBe(TEXTO_EMERGENCIA);
    expect(vistas).toHaveLength(1);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_no_cargado')).toMatchObject({ codigo: 'banco_sha_distinto' });
    expect(bitacora.eventos.some((e) => e.tipo === 'enrutador')).toBe(false);
    await app.close();
  });

  it('sin CHATBOTRAG_ENRUTADOR (apagado) el banco válido no cambia nada: IA, sin eventos del enrutador y mismo aviso de arranque', async () => {
    const { app, enviar, vistas, bitacora } = await levantar({});
    const r = await enviar('termino emergencia ejemplo');
    expect(r.json().texto).not.toBe(TEXTO_EMERGENCIA);
    expect(vistas).toHaveLength(1);
    expect(bitacora.eventos.some((e) => e.tipo === 'enrutador')).toBe(false);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toBe('calibracion=si');
    await app.close();
  });

  it('un embebedor caído al arrancar no detiene el servicio: la exacta sigue y la semántica queda apagada', async () => {
    const embebedor = new EmbebedorTabla();
    embebedor.falla = true;
    const { app, enviar, vistas, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor });
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toBe('calibracion=si semantica=no enrutador=activo');
    expect((await enviar('termino emergencia ejemplo')).json().texto).toBe(TEXTO_EMERGENCIA);
    const r = await enviar('consulta sobre siniestro');
    expect(r.statusCode).toBe(200);
    expect(vistas).toHaveLength(1);
    expect(bitacora.eventos.filter((e) => e.tipo === 'enrutador').at(-1)).toMatchObject({ carril: 'ia', motivo: 'semantica_no_disponible' });
    await app.close();
  });

  it('activo_fijo con carrilFijo en la configuración: el texto fijo sale sin llamar al modelo, de punta a punta', async () => {
    const { app, enviar, vistas, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo_fijo' }, { carrilFijo: true });
    const r = await enviar('pregunta sintetica de contacto');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ texto: '(ejemplo) Texto sintético de contacto.', propuestas: [], botones: [] });
    expect(vistas).toHaveLength(0);
    expect(bitacora.eventos.find((e) => e.tipo === 'enrutador')).toMatchObject({ carril: 'fijo', via: 'exacta' });
    await app.close();
  });

  it('el fijo exige las dos llaves: activo_fijo sin carrilFijo en la configuración, o carrilFijo con solo «activo», va a la IA', async () => {
    const a = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo_fijo' }, { carrilFijo: false });
    await a.enviar('pregunta sintetica de contacto');
    expect(a.vistas).toHaveLength(1);
    await a.app.close();
    const b = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { carrilFijo: true });
    await b.enviar('pregunta sintetica de contacto');
    expect(b.vistas).toHaveLength(1);
    await b.app.close();
  });

  it('cuota al preparar el índice semántico: un solo reintento tras la espera inyectada y la semántica queda encendida', async () => {
    const embebedor = new EmbebedorTabla();
    embebedor.fallasIniciales = [Object.assign(new Error('cuota'), { causa: 'cuota' })];
    const esperas: number[] = [];
    const { app, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor, esperar: async (ms) => void esperas.push(ms) });
    expect(esperas).toEqual([2000]);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toBe('calibracion=si semantica=si enrutador=activo');
    await app.close();
  });

  it('dos cuotas seguidas: solo se reintenta una vez y el servicio arranca sin semántica', async () => {
    const embebedor = new EmbebedorTabla();
    embebedor.fallasIniciales = [Object.assign(new Error('a'), { causa: 'saturacion' }), Object.assign(new Error('b'), { causa: 'cuota' })];
    const esperas: number[] = [];
    const { app, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor, esperar: async (ms) => void esperas.push(ms) });
    expect(esperas).toHaveLength(1);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toBe('calibracion=si semantica=no enrutador=activo');
    await app.close();
  });

  it('un error que no es de cuota ni saturación no se reintenta', async () => {
    const embebedor = new EmbebedorTabla();
    embebedor.fallasIniciales = [new Error('otro fallo')];
    const esperas: number[] = [];
    const { app, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor, esperar: async (ms) => void esperas.push(ms) });
    expect(esperas).toEqual([]);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toContain('semantica=no');
    await app.close();
  });

  it('activo_fijo con carrilFijo en la configuración: el texto fijo sale sin modelo; con «activo» va a la IA', async () => {
    const fijo = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo_fijo' }, { carrilFijo: true });
    const r = await fijo.enviar('pregunta sintetica de contacto');
    expect(r.json()).toMatchObject({ texto: '(ejemplo) Texto sintético de contacto.', propuestas: [], botones: [] });
    expect(fijo.vistas).toHaveLength(0);
    expect(fijo.bitacora.eventos.find((e) => e.tipo === 'enrutador')).toMatchObject({ carril: 'fijo', via: 'exacta' });
    await fijo.app.close();

    const soloActivo = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { carrilFijo: true });
    await soloActivo.enviar('pregunta sintetica de contacto');
    expect(soloActivo.vistas).toHaveLength(1);
    await soloActivo.app.close();

    // La variable sola tampoco: activo_fijo con la configuración en carrilFijo falso.
    const sinConfig = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo_fijo' });
    await sinConfig.enviar('pregunta sintetica de contacto');
    expect(sinConfig.vistas).toHaveLength(1);
    await sinConfig.app.close();
  });

  it('índice semántico: cuota al arrancar se reintenta UNA vez tras la espera y la semántica queda disponible', async () => {
    const embebedor = new EmbebedorTabla();
    embebedor.fallasCuota = 1;
    const esperas: number[] = [];
    const { app, bitacora } = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor, esperar: async (ms) => void esperas.push(ms) });
    expect(esperas).toEqual([2000]);
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toBe('calibracion=si semantica=si enrutador=activo');
    await app.close();
  });

  it('índice semántico: si la cuota persiste tras el reintento, arranca sin semántica; un error distinto no se reintenta', async () => {
    const dosCuotas = new EmbebedorTabla();
    dosCuotas.fallasCuota = 2;
    const esperas: number[] = [];
    const a = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor: dosCuotas, esperar: async (ms) => void esperas.push(ms) });
    expect(esperas).toHaveLength(1);
    expect(a.bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toContain('semantica=no');
    await a.app.close();

    const otro = new EmbebedorTabla();
    otro.falla = true;
    const esperasB: number[] = [];
    const b = await levantar({ CHATBOTRAG_ENRUTADOR: 'activo' }, { embebedor: otro, esperar: async (ms) => void esperasB.push(ms) });
    expect(esperasB).toHaveLength(0);
    expect(b.bitacora.eventos.find((e) => e.tipo === 'banco_cargado')?.detalle).toContain('semantica=no');
    await b.app.close();
  });
});
