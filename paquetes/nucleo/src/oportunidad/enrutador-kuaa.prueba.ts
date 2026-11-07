/**
 * Pruebas del enrutador conectado a Kuaa (H4d). Proveedor guionado, embebedor por tabla con contador y un banco SINTÉTICO
 * armado aquí mismo: ningún texto real. Los vectores son ortogonales (uno por pregunta del banco), así que la decisión
 * semántica es exacta y no depende de umbrales finos.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { Calibracion } from '../banco/calibracion.js';
import { cargarBanco } from '../banco/cargar.js';
import { EmbebedorConMemoria } from '../banco/embebedor-memo.js';
import { prepararEnrutador } from '../banco/enrutador.js';
import { VERSION_REGLA_DECISION, prepararIndiceSemantico, type IndiceSemantico } from '../banco/similitud.js';
import { cargarConfiguracionDesdeJson } from '../configuracion/cargar.js';
import type { ConfiguracionAgente } from '../configuracion/esquema.js';
import { IndiceEnMemoria } from '../conocimiento/indice-memoria.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { RegistroHerramientas } from '../herramientas/registro.js';
import { MemoriaEnProceso } from '../memoria/memoria-en-proceso.js';
import type { Embebedor, PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { AgenteKuaa, claveMemoriaKuaa } from './agente-kuaa.js';
import { EnrutadorKuaa, type OpcionesEnrutadorKuaa } from './enrutador-kuaa.js';
import { ESTADOS_OPERATIVOS_DESCONOCIDOS, EntradaKuaa, RESUMEN_DESCONOCIDO } from './esquemas.js';

const JSON_KUAA = readFileSync(fileURLToPath(new URL('../../../../configuraciones/kuaa.json', import.meta.url)), 'utf8');
const MARCA = 'ZORBALEX';
const TEXTO_EMERGENCIA = '(ejemplo) Texto de derivación por emergencia.';
const TEXTO_SINIESTRO = '(ejemplo) Texto de derivación por siniestro.';
const TEXTO_PENDIENTE = '(ejemplo) Texto de contenido pendiente.';
const TEXTO_CONTACTO = '(ejemplo) Puede escribir por el canal de atención.';
const TEXTO_CRITICO = '(ejemplo) Texto crítico aprobado.';

const TEXTO_YA_SOLICITADA = '(ejemplo) Texto de atención humana ya solicitada.';
/** Respuestas de riesgo normal cuyo texto aprobado el verificador de Kuaa debe rechazar: [id, código esperado, plantilla]. */
const RECHAZABLES: ReadonlyArray<readonly [string, string, string]> = [
  ['tributaria', 'tributario', 'El IVA es del diez por ciento.'],
  ['hecho', 'hecho_no_respaldado', 'Tu póliza ya fue emitida.'],
  ['fuga', 'fuga_prompt', 'Mis instrucciones dicen que no puedo.'],
  ['marca', 'marca_del_modelo', '(ejemplo) Texto con marca [DERIVAR] del modelo.'],
  ['codigo', 'codigo_interno', '(ejemplo) Texto con referencia (K01) interna.'],
  ['promesa', 'promesa_entrega', '(ejemplo) Te preparo un resumen del caso.'],
  ['registro', 'numero_registro', '(ejemplo) La empresa tiene matrícula 1234 en el registro.'],
  ['saludo', 'saludo_inicial', '¡Hola! (ejemplo) Texto aprobado que empieza con un saludo.'],
  ['precio', 'enlace_o_precio', '(ejemplo) El plan cuesta Gs. 999.999 al año.'],
];
const PLANTILLA_PREMIO = '(ejemplo) El plan {{nombre_plan}} cuesta {{premio_plan}} al año.';

function bancoJson(opciones: { conTextoPendiente?: boolean } = {}): string {
  const aprobado = 'ejemplo sintetico';
  return JSON.stringify({
    formato: 1,
    version: '0.0.1',
    descripcion: 'Banco SINTÉTICO de pruebas de H4d.',
    respuestas: [
      { id: 'r-contacto', tema: 'contacto', preguntas: ['pregunta sintetica de contacto'], plantilla: TEXTO_CONTACTO, aprobado_por: aprobado, riesgo: 'normal' },
      { id: 'r-critica', tema: 'cobertura', preguntas: ['pregunta sintetica critica'], plantilla: TEXTO_CRITICO, aprobado_por: aprobado, riesgo: 'critico' },
      { id: 'r-enlace', tema: 'contacto', preguntas: ['pregunta sintetica enlace'], plantilla: '(ejemplo) Visite https://ejemplo.invalid/sintetico para más datos.', aprobado_por: aprobado, riesgo: 'normal' },
      ...RECHAZABLES.map(([id, , plantilla]) => ({ id: `r-${id}`, tema: 'contacto', preguntas: [`pregunta sintetica ${id}`], plantilla, aprobado_por: aprobado, riesgo: 'normal' })),
      { id: 'r-premio', tema: 'contacto', preguntas: ['pregunta sintetica premio'], plantilla: PLANTILLA_PREMIO, aprobado_por: aprobado, riesgo: 'normal' },
      { id: 'r-atencion', tema: 'contacto', preguntas: ['pregunta sintetica atencion'], plantilla: '(ejemplo) Texto fijo con atención.', aprobado_por: aprobado, riesgo: 'normal', derivar_cuando: ['atencion_humana_solicitada'] },
      { id: 'r-critica-enlace', tema: 'cobertura', preguntas: ['pregunta sintetica critica enlace'], plantilla: '(ejemplo) Visite https://ejemplo.invalid/critico para más datos.', aprobado_por: aprobado, riesgo: 'critico' },
    ],
    derivaciones: [
      { id: 'd-emergencia', motivo: 'emergencia', terminos: ['termino emergencia ejemplo'], texto: TEXTO_EMERGENCIA, aprobado_por: aprobado },
      { id: 'd-siniestro', motivo: 'siniestro_particular', preguntas: ['pregunta sintetica de siniestro'], texto: TEXTO_SINIESTRO, aprobado_por: aprobado },
    ],
    textos_derivacion: [
      { motivo: 'atencion_humana_ya_solicitada', texto: TEXTO_YA_SOLICITADA, aprobado_por: aprobado },
      ...(opciones.conTextoPendiente === false ? [] : [{ motivo: 'contenido_pendiente', texto: TEXTO_PENDIENTE, aprobado_por: aprobado }]),
    ],
  });
}

const DIM = 24;
/** Pregunta del banco o fragmento de consulta -> eje del vector. Lo que no figura va al eje 7, que ninguna entrada usa. */
const EJES: ReadonlyArray<readonly [string, number]> = [
  ['pregunta sintetica de siniestro', 0],
  ['consulta parecida siniestro', 0],
  ['pregunta sintetica de contacto', 1],
  ['consulta parecida contacto', 1],
  ['pregunta sintetica critica enlace', 4],
  ['pregunta sintetica critica', 2],
  ['consulta parecida critica', 2],
  ['pregunta sintetica enlace', 3],
  ...RECHAZABLES.map(([id], i) => [`pregunta sintetica ${id}`, 8 + i] as const),
  ['pregunta sintetica premio', 20],
  ['pregunta sintetica atencion', 21],
];

class EmbebedorPorTabla implements Embebedor {
  nombre = 'modelo-prueba';
  dimension = DIM;
  /** Cada lote pedido, en orden. */
  readonly lotes: string[][] = [];
  falla = false;
  demoraMs = 0;
  /** Cuántas veces se pidió el vector de este texto (solo lotes de un texto, los de las consultas). */
  llamadasDe(texto: string): number {
    return this.lotes.filter((l) => l.length === 1 && l[0] === texto).length;
  }
  async embeber(textos: string[]): Promise<number[][]> {
    this.lotes.push([...textos]);
    if (this.demoraMs > 0) await new Promise((r) => setTimeout(r, this.demoraMs));
    if (this.falla) throw new Error('embebedor caído');
    return textos.map((t) => {
      const v = new Array<number>(DIM).fill(0);
      // La más larga primero: «critica enlace» antes que «critica».
      const eje = EJES.find(([clave]) => t.includes(clave))?.[1] ?? 7;
      v[eje] = 1;
      return v;
    });
  }
}

const calibracionDe = (sha: string, cambios: Record<string, unknown> = {}) =>
  Calibracion.parse({
    formato: 1,
    regla: VERSION_REGLA_DECISION,
    banco_sha256: sha,
    evaluacion_sha256: 'b'.repeat(64),
    proveedor: 'vertex',
    modelo: 'modelo-prueba',
    dimension: DIM,
    umbral_fijo: 0.8,
    umbral_derivacion: 0.7,
    margen: 0.1,
    valido: true,
    motivos_invalidez: [],
    control: { total: 100, confusiones: 0, falsos_positivos: 0 },
    medido: '2026-11-05',
    ...cambios,
  });

class Proveedor implements ProveedorLLM {
  readonly nombre = 'guionado';
  readonly peticiones: PeticionLLM[] = [];
  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    this.peticiones.push(p);
    const texto = JSON.stringify({ texto: 'Te cuento lo que sé sobre el proceso. ¿Seguimos?', etapa_propuesta: 'E04', objecion: null, botones: ['ver_planes'], propuestas: [] });
    return { texto, llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 10, tokensSalida: 5 } };
  }
}

const entrada = (mensaje: string, cambios: Record<string, unknown> = {}) =>
  EntradaKuaa.parse({
    oportunidad_id: 'op-sintetica-1',
    etapa_actual: 'E04',
    estados: { ...ESTADOS_OPERATIVOS_DESCONOCIDOS },
    permiso_seguimiento: { vigente: false, canal: 'ninguno' },
    tarifa_version: null,
    pagina: null,
    resumen: { ...RESUMEN_DESCONOCIDO },
    mensaje,
    ...cambios,
  });

interface Montaje {
  carrilFijo?: boolean;
  activoEnConfig?: boolean;
  /** `null` = sin opciones de enrutador (como hoy). */
  modo?: OpcionesEnrutadorKuaa['modo'] | null;
  calibracion?: Record<string, unknown> | 'ninguna';
  sinIndiceSemantico?: boolean;
  admitirSimulado?: boolean;
  topeEmbeddingMs?: number;
  conTextoPendiente?: boolean;
}

async function montar(m: Montaje = {}) {
  const base: ConfiguracionAgente = cargarConfiguracionDesdeJson(JSON_KUAA);
  const config: ConfiguracionAgente = { ...base, enrutador: { activo: m.activoEnConfig ?? true, carrilFijo: m.carrilFijo ?? false } };
  const cargado = cargarBanco(bancoJson(m.conTextoPendiente === undefined ? {} : { conTextoPendiente: m.conTextoPendiente }), { admitirSintetico: true });
  const embebedor = new EmbebedorPorTabla();
  const memo = new EmbebedorConMemoria(embebedor);
  let indiceSemantico: IndiceSemantico | null = null;
  if (!m.sinIndiceSemantico) indiceSemantico = await prepararIndiceSemantico(cargado.banco, embebedor);
  const indice = new IndiceEnMemoria(memo);
  await indice.indexar([{ id: 'f1', coleccion: coleccionDe(config, null), fuenteId: 'doc', fuenteTitulo: 'Documento sintético', fuenteVersion: 'v1', orden: 0, texto: 'El proceso tiene cuatro pasos sintéticos.' }]);
  const proveedor = new Proveedor();
  const bitacora = new BitacoraEnMemoria();
  const memoria = new MemoriaEnProceso();
  const modo = m.modo === undefined ? 'activo_fijo' : m.modo;
  const enrutador: OpcionesEnrutadorKuaa | undefined =
    modo === null
      ? undefined
      : {
          modo,
          indice: prepararEnrutador(cargado.banco, cargado.sha256),
          calibracion: m.calibracion === 'ninguna' ? null : calibracionDe(cargado.sha256, m.calibracion),
          indiceSemantico,
          embebedor: memo,
          ...(m.admitirSimulado === undefined ? {} : { admitirSimulado: m.admitirSimulado }),
          ...(m.topeEmbeddingMs === undefined ? {} : { topeEmbeddingMs: m.topeEmbeddingMs }),
        };
  const agente = new AgenteKuaa(
    { config, proveedor, indice, memoria, herramientas: new RegistroHerramientas(null), bitacora, reloj: () => new Date('2026-11-05T12:00:00Z') },
    { enrutador },
  );
  // Lo anterior (índice del banco y del RAG) no cuenta: se mide desde aquí.
  embebedor.lotes.length = 0;
  return { agente, proveedor, bitacora, memoria, embebedor, config };
}

const enrutadorEventos = (b: BitacoraEnMemoria) => b.eventos.filter((e) => e.tipo === 'enrutador');

describe('igualdad con el enrutador apagado', () => {
  const mensajes = ['¿Cómo es el proceso?', 'pregunta sintetica de contacto', 'termino emergencia ejemplo', 'consulta parecida siniestro', 'hola'];
  it.each([
    ['sin opciones de enrutador (variable apagada)', { modo: null } as Montaje],
    ['configuración con enrutador.activo en falso', { activoEnConfig: false } as Montaje],
  ])('%s: mismos argumentos a generar, misma salida, mismos eventos y mismas llamadas de embedding', async (_n, apagado) => {
    const referencia = await montar({ modo: null, activoEnConfig: true });
    const otro = await montar(apagado);
    for (const mensaje of mensajes) {
      const a = await referencia.agente.responder(entrada(mensaje), 'cliente-a');
      const b = await otro.agente.responder(entrada(mensaje), 'cliente-a');
      expect(b).toEqual(a);
    }
    expect(JSON.stringify(otro.proveedor.peticiones)).toBe(JSON.stringify(referencia.proveedor.peticiones));
    expect(otro.proveedor.peticiones).toHaveLength(mensajes.length);
    expect(otro.bitacora.eventos).toEqual(referencia.bitacora.eventos);
    expect(enrutadorEventos(otro.bitacora)).toHaveLength(0);
    expect(otro.embebedor.lotes).toEqual(referencia.embebedor.lotes);
  });
});

describe('carril derivación', () => {
  it('derivación exacta (término de emergencia): texto del banco, propuesta de atención humana, sin llamar al modelo ni al embedding', async () => {
    const { agente, proveedor, bitacora, embebedor } = await montar();
    const { salida, avisos } = await agente.responder(entrada('termino emergencia ejemplo'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(embebedor.lotes).toHaveLength(0);
    expect(salida).toMatchObject({ texto: TEXTO_EMERGENCIA, etapa_propuesta: 'E04', botones: [], propuestas: ['atencion_humana_solicitada'] });
    expect(avisos).toContain('carril:derivacion');
    const [ev] = enrutadorEventos(bitacora);
    expect(ev).toMatchObject({ carril: 'derivacion', via: 'exacta', motivo: 'emergencia' });
    expect(bitacora.eventos.at(-1)).toMatchObject({ tipo: 'mensaje_atendido', iteraciones: 0 });
  });

  it('derivación semántica: una sola llamada de embedding, texto del banco y similitud redondeada en la bitácora', async () => {
    const { agente, proveedor, bitacora, embebedor } = await montar();
    const { salida } = await agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(embebedor.llamadasDe('consulta parecida siniestro')).toBe(1);
    expect(salida).toMatchObject({ texto: TEXTO_SINIESTRO, propuestas: ['atencion_humana_solicitada'] });
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'derivacion', via: 'semantica', similitud: 1, motivo: 'siniestro_particular' });
  });

  it('se guarda en la memoria de conversación como cualquier otro turno', async () => {
    const { agente, memoria } = await montar();
    await agente.responder(entrada('termino emergencia ejemplo'), 'cliente-a');
    const turnos = await memoria.leer(claveMemoriaKuaa('cliente-a', 'op-sintetica-1'), 10);
    expect(turnos.map((t) => t.rol)).toEqual(['usuario', 'asistente']);
    expect(turnos[1]?.contenido).toContain(TEXTO_EMERGENCIA);
  });

  it('un crítico con el carril fijo apagado deriva por D1 (contenido pendiente), sin modelo', async () => {
    const { agente, proveedor, bitacora } = await montar({ carrilFijo: false, modo: 'activo' });
    const { salida } = await agente.responder(entrada('pregunta sintetica critica'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida).toMatchObject({ texto: TEXTO_PENDIENTE, propuestas: ['atencion_humana_solicitada'] });
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'derivacion', motivo: 'contenido_pendiente' });
  });

  it('sin el texto de contenido pendiente en el banco: mensaje general de la configuración con la propuesta (D5)', async () => {
    const { agente, proveedor, config } = await montar({ carrilFijo: true, conTextoPendiente: false });
    const { salida, avisos } = await agente.responder(entrada('pregunta sintetica critica enlace'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida.texto).toBe(config.mensajes.derivacion);
    expect(salida.propuestas).toEqual(['atencion_humana_solicitada']);
    expect(avisos).toContain('texto_fijo_rechazado:verificacion_adicional');
  });
});

describe('carril fijo', () => {
  it('con carrilFijo en la configuración y activo_fijo: texto aprobado, sin modelo y sin propuestas', async () => {
    const { agente, proveedor, bitacora } = await montar({ carrilFijo: true });
    const { salida } = await agente.responder(entrada('pregunta sintetica de contacto'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida).toMatchObject({ texto: TEXTO_CONTACTO, propuestas: [], botones: [] });
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'fijo', via: 'exacta' });
  });

  it('fijo por semántica', async () => {
    const { agente, proveedor, bitacora } = await montar({ carrilFijo: true });
    const { salida } = await agente.responder(entrada('consulta parecida contacto'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida.texto).toBe(TEXTO_CONTACTO);
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'fijo', via: 'semantica', similitud: 1 });
  });

  it('la variable sola no enciende el fijo: activo_fijo con carrilFijo apagado en la configuración va a la IA', async () => {
    const { agente, proveedor, bitacora } = await montar({ carrilFijo: false, modo: 'activo_fijo' });
    await agente.responder(entrada('pregunta sintetica de contacto'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'ia', motivo: 'carril_fijo_apagado' });
  });

  it('la configuración sola tampoco: modo «activo» con carrilFijo en la configuración va a la IA', async () => {
    const { agente, proveedor } = await montar({ carrilFijo: true, modo: 'activo' });
    await agente.responder(entrada('pregunta sintetica de contacto'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
  });

  it('un texto fijo que el verificador de Kuaa rechaza (enlace) cae a la IA si es de riesgo normal', async () => {
    const { agente, proveedor } = await montar({ carrilFijo: true });
    const { avisos } = await agente.responder(entrada('pregunta sintetica enlace'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(avisos).toContain('texto_fijo_rechazado:verificacion_adicional');
    expect(avisos).toContain('enlace_o_precio');
  });

  it('el mismo rechazo en un crítico deriva con el texto de contenido pendiente (D5)', async () => {
    const { agente, proveedor } = await montar({ carrilFijo: true });
    const { salida } = await agente.responder(entrada('pregunta sintetica critica enlace'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida).toMatchObject({ texto: TEXTO_PENDIENTE, propuestas: ['atencion_humana_solicitada'] });
  });
});

describe('calibración y semántica: ante cualquier duda, la IA de siempre', () => {
  it.each([
    ['modelo distinto', { modelo: 'otro-modelo' }],
    ['dimensión distinta', { dimension: 16 }],
    ['proveedor simulado fuera de pruebas', { proveedor: 'simulado' }],
    ['calibración inválida', { valido: false, motivos_invalidez: ['confusion_en_control'], control: { total: 100, confusiones: 1, falsos_positivos: 0 } }],
  ] as const)('%s: sin semántica, motivo calibracion_no_apta y ni un embedding para la consulta', async (_n, cambios) => {
    const { agente, proveedor, bitacora, embebedor } = await montar({ calibracion: { ...cambios } });
    const { salida } = await agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(salida.texto).not.toBe(TEXTO_SINIESTRO);
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'ia', via: 'semantica', motivo: 'calibracion_no_apta' });
    // La consulta solo la pide el RAG (una vez); el enrutador no gastó la suya.
    expect(embebedor.llamadasDe('consulta parecida siniestro')).toBe(1);
  });

  it('proveedor simulado con admitirSimulado (solo pruebas): la semántica funciona', async () => {
    const { agente, proveedor } = await montar({ calibracion: { proveedor: 'simulado' }, admitirSimulado: true });
    const { salida } = await agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida.texto).toBe(TEXTO_SINIESTRO);
  });

  it('sin calibración: la exacta funciona y la semántica no está disponible', async () => {
    const { agente, proveedor, bitacora } = await montar({ calibracion: 'ninguna' });
    await agente.responder(entrada('termino emergencia ejemplo'), 'cliente-a');
    await agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(enrutadorEventos(bitacora).map((e) => e.motivo)).toEqual(['emergencia', 'semantica_no_disponible']);
  });

  it('índice semántico que no se pudo preparar al arrancar: semantica_no_disponible, sin consultar el embedding', async () => {
    const { agente, proveedor, bitacora } = await montar({ sinIndiceSemantico: true });
    await agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'ia', motivo: 'semantica_no_disponible' });
  });

  it('fallo del embebedor: la IA responde y la bitácora dice embebedor_error', async () => {
    const m = await montar();
    m.embebedor.falla = true;
    const { salida } = await m.agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(m.proveedor.peticiones).toHaveLength(1);
    expect(salida.texto).not.toBe(TEXTO_SINIESTRO);
    expect(enrutadorEventos(m.bitacora)[0]).toMatchObject({ carril: 'ia', motivo: 'embebedor_error' });
  });

  it('tiempo vencido: la IA responde y la bitácora dice embebedor_tiempo', async () => {
    const m = await montar({ topeEmbeddingMs: 20 });
    m.embebedor.demoraMs = 150;
    const { salida } = await m.agente.responder(entrada('consulta parecida siniestro'), 'cliente-a');
    expect(m.proveedor.peticiones).toHaveLength(1);
    expect(salida.texto).not.toBe(TEXTO_SINIESTRO);
    expect(enrutadorEventos(m.bitacora)[0]).toMatchObject({ carril: 'ia', motivo: 'embebedor_tiempo' });
  });

  it('el vector se comparte con el RAG: un mensaje que sigue por la IA gasta UNA llamada de embedding', async () => {
    const { agente, proveedor, embebedor, bitacora } = await montar();
    await agente.responder(entrada('consulta lejana de todo'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(embebedor.llamadasDe('consulta lejana de todo')).toBe(1);
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'ia', motivo: 'sin_coincidencia' });
  });
});

describe('bitácora sin texto', () => {
  it('ningún evento lleva el mensaje de la persona ni textos del banco, en ninguno de los carriles', async () => {
    const { agente, bitacora } = await montar({ carrilFijo: true });
    await agente.responder(entrada(`termino emergencia ejemplo ${MARCA}`), 'cliente-a');
    await agente.responder(entrada(`consulta parecida siniestro ${MARCA}`), 'cliente-a');
    await agente.responder(entrada(`consulta parecida contacto ${MARCA}`), 'cliente-a');
    await agente.responder(entrada(`consulta lejana ${MARCA}`), 'cliente-a');
    await agente.responder(entrada('pregunta sintetica enlace'), 'cliente-a');
    expect(enrutadorEventos(bitacora)).toHaveLength(5);
    const todo = JSON.stringify(bitacora.eventos);
    for (const prohibido of [MARCA, 'termino emergencia', 'consulta parecida', 'ejemplo.invalid', TEXTO_EMERGENCIA, TEXTO_SINIESTRO, TEXTO_CONTACTO, 'Texto de derivación']) {
      expect(todo).not.toContain(prohibido);
    }
  });
});

describe('límite documentado: la entrada bloqueada va primero', () => {
  it.each(['me quiero suicidar, tengo depresión', 'tengo cáncer y estoy muy mal, ayuda urgente', 'estoy embarazada y tuve un sangrado fuerte'])(
    'un mensaje de emergencia que menciona salud («%s») recibe entradaBloqueada hoy: D10 pendiente de decisión de Andres (comportamiento previo)',
    async (mensaje) => {
      const { agente, proveedor, bitacora, config } = await montar();
      const { salida } = await agente.responder(entrada(mensaje), 'cliente-a');
      expect(salida.texto).toBe(config.mensajes.entradaBloqueada);
      expect(proveedor.peticiones).toHaveLength(0);
      expect(enrutadorEventos(bitacora)).toHaveLength(0);
    },
  );
  it('un mensaje que la compuerta de entrada bloquea no llega al enrutador (D10 no existe en el contrato de enrutar)', async () => {
    const { agente, proveedor, bitacora, config } = await montar();
    const { salida } = await agente.responder(entrada('termino emergencia ejemplo, mi cédula es 4567890'), 'cliente-a');
    expect(salida.texto).toBe(config.mensajes.entradaBloqueada);
    expect(proveedor.peticiones).toHaveLength(0);
    expect(enrutadorEventos(bitacora)).toHaveLength(0);
  });
});

const PLATAFORMA = {
  version: 'v0.4',
  catalogo: [{ producto: 'VIDA_ONCOLOGICO', nombre: 'Vida con cobertura oncológica', estado: 'disponible' }],
  planes: [
    {
      producto: 'VIDA_ONCOLOGICO',
      plan: 'CONFIO',
      nombre: 'Confio Basico',
      premio_anual_gs: 390000,
      capital_fallecimiento_gs: 20000000,
      indemnizacion_cancer_gs: 10000000,
      renta_hospitalaria_dia_gs: 100000,
      renta_dias_max: 30,
      gastos_medicos_accidente_gs: 2000000,
    },
  ],
  contacto: { whatsapp_e164: '+595991478468' },
};

describe('el verificador de Kuaa rechaza el texto aprobado que cambiaría al pasar por los filtros del modelo', () => {
  it.each(RECHAZABLES.map(([id, codigo]) => [id, codigo] as const))('«%s» se descarta con el código «%s», sigue a la IA y el evento dice el carril final', async (id, codigo) => {
    const { agente, proveedor, bitacora } = await montar({ carrilFijo: true });
    const { avisos } = await agente.responder(entrada(`pregunta sintetica ${id}`, { plataforma: PLATAFORMA }), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(avisos).toContain('texto_fijo_rechazado:verificacion_adicional');
    expect(avisos).toContain(codigo);
    expect(avisos).toContain('carril:ia');
    const ev = enrutadorEventos(bitacora);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ carril: 'ia' });
    expect(ev[0]?.motivo).toBeUndefined();
    expect(ev[0]?.avisos).toEqual(expect.arrayContaining(['carril_final:ia', 'texto_fijo_rechazado:verificacion_adicional']));
    expect(ev[0]?.avisos).not.toContain('carril:fijo');
  });

  it('una marca literal declarada en la configuración NO se rechaza como marca', async () => {
    const { verificadorKuaa } = await import('./enrutador-kuaa.js');
    const v = verificadorKuaa(undefined, { ...ESTADOS_OPERATIVOS_DESCONOCIDOS }, ['LITERAL']);
    expect(v('(ejemplo) Texto con [LITERAL] a la vista.')).toBeNull();
    expect(v('(ejemplo) Texto con [DERIVAR] a la vista.')).toBe('marca_del_modelo');
  });

  it('una plantilla con variables de plataforma pasa con el importe de la plataforma (permitido)', async () => {
    const { agente, proveedor } = await montar({ carrilFijo: true });
    const { salida, avisos } = await agente.responder(entrada('pregunta sintetica premio', { plataforma: PLATAFORMA, resumen: { ...RESUMEN_DESCONOCIDO, plan: 'CONFIO' } }), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida.texto).toContain('Confio Basico');
    expect(salida.texto).toMatch(/390\.000/);
    expect(avisos).toEqual(expect.arrayContaining(['carril:fijo', 'plataforma:v0.4']));
  });

  it('la misma plantilla sin datos de plataforma (faltan datos) se descarta y sigue a la IA', async () => {
    const { agente, proveedor } = await montar({ carrilFijo: true });
    const { avisos } = await agente.responder(entrada('pregunta sintetica premio'), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(1);
    expect(avisos).toContain('texto_fijo_rechazado:faltan_datos');
  });
});

describe('atención humana ya solicitada', () => {
  it.each(['en_curso', 'solicitada'] as const)('con atencion_humana «%s» la respuesta con esa condición deriva', async (estado) => {
    const { agente, proveedor, bitacora } = await montar({ carrilFijo: true });
    const { salida } = await agente.responder(entrada('pregunta sintetica atencion', { estados: { ...ESTADOS_OPERATIVOS_DESCONOCIDOS, atencion_humana: estado } }), 'cliente-a');
    expect(proveedor.peticiones).toHaveLength(0);
    expect(salida).toMatchObject({ texto: TEXTO_YA_SOLICITADA, propuestas: ['atencion_humana_solicitada'] });
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'derivacion', motivo: 'atencion_humana_ya_solicitada' });
  });

  it.each(['desconocido', 'no_requerida', 'resuelta'] as const)('con atencion_humana «%s» sale el texto fijo', async (estado) => {
    const { agente } = await montar({ carrilFijo: true });
    const { salida } = await agente.responder(entrada('pregunta sintetica atencion', { estados: { ...ESTADOS_OPERATIVOS_DESCONOCIDOS, atencion_humana: estado } }), 'cliente-a');
    expect(salida.texto).toBe('(ejemplo) Texto fijo con atención.');
    expect(salida.propuestas).toEqual([]);
  });
});

describe('bitácora de los carriles y del camino de error', () => {
  it('el carril IA se anota en mensaje_atendido solo con el enrutador encendido', async () => {
    const encendido = await montar();
    await encendido.agente.responder(entrada('consulta lejana de todo'), 'cliente-a');
    expect(encendido.bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')?.avisos).toContain('carril:ia');
    const apagado = await montar({ modo: null });
    await apagado.agente.responder(entrada('consulta lejana de todo'), 'cliente-a');
    expect(apagado.bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')?.avisos?.some((a) => a.startsWith('carril'))).toBe(false);
  });

  it('un fijo crítico que D5 convierte en derivación deja el evento con el carril final', async () => {
    const { agente, bitacora } = await montar({ carrilFijo: true });
    await agente.responder(entrada('pregunta sintetica critica enlace'), 'cliente-a');
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'derivacion', motivo: 'contenido_pendiente' });
    expect(enrutadorEventos(bitacora)[0]?.avisos).toContain('carril_final:derivacion');
  });

  it('los carriles fijo y derivación anotan la versión de la plataforma, como el carril IA', async () => {
    const { agente } = await montar({ carrilFijo: true });
    const a = await agente.responder(entrada('termino emergencia ejemplo', { plataforma: PLATAFORMA }), 'cliente-a');
    const b = await agente.responder(entrada('pregunta sintetica de contacto', { plataforma: PLATAFORMA }), 'cliente-a');
    expect(a.avisos).toContain('plataforma:v0.4');
    expect(b.avisos).toContain('plataforma:v0.4');
    expect(JSON.stringify([a.avisos, b.avisos])).not.toContain('+595');
  });

  it('si el enrutador falla por dentro: responde la IA, queda el aviso y el evento enrutador con el motivo', async () => {
    const espia = vi.spyOn(EnrutadorKuaa.prototype, 'decidir').mockRejectedValueOnce(new Error(`detalle ${MARCA}`));
    try {
      const { agente, proveedor, bitacora } = await montar({ carrilFijo: true });
      const { avisos } = await agente.responder(entrada('termino emergencia ejemplo'), 'cliente-a');
      expect(proveedor.peticiones).toHaveLength(1);
      expect(avisos).toContain('enrutador_error');
      expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'ia', avisos: ['carril:ia', 'motivo_ia:enrutador_error'] });
      expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA);
    } finally {
      espia.mockRestore();
    }
  });
});

describe('cortesía', () => {
  it('una cortesía no gasta embedding del enrutador ni de nadie y sigue por la IA', async () => {
    const { agente, proveedor, embebedor, bitacora } = await montar({ carrilFijo: true });
    await agente.responder(entrada('gracias'), 'cliente-a');
    expect(embebedor.lotes).toHaveLength(0);
    expect(proveedor.peticiones).toHaveLength(1);
    expect(enrutadorEventos(bitacora)[0]).toMatchObject({ carril: 'ia', motivo: 'semantica_no_disponible' });
  });
});
