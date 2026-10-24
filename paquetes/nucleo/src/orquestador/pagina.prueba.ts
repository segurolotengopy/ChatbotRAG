/**
 * PRUEBAS DEL CONTEXTO DE PÁGINA
 *
 * Fixture propio (no depende de `agente.prueba.ts`): un agente con tres fuentes (dos manuales
 * de pantalla y un documento general) y un perfil con su propio manual. Lo que se protege:
 *  - `pagina` solo SELECCIONA un manual ya declarado; el valor del cliente nunca llega al
 *    prompt ni a la bitácora, sea válido o no.
 *  - Sin `pagina`, el prompt es el de siempre.
 *  - El manual inyectado respeta el tope de caracteres y cuenta como respaldo.
 */
import { describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { ErrorConfiguracion, validarConfiguracion } from '../configuracion/cargar.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { cargarCorpus, coleccionDe, quitarComentariosHtml } from '../conocimiento/cargar-corpus.js';
import { IndiceEnMemoria } from '../conocimiento/indice-memoria.js';
import { RegistroHerramientas } from '../herramientas/registro.js';
import { MemoriaEnProceso } from '../memoria/memoria-en-proceso.js';
import { armarPrompt } from '../prompt/armar.js';
import { ProveedorSimulado } from '../proveedores/simulado.js';
import type { PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import type { Fragmento } from '../puertos/indice-conocimiento.js';
import { Agente } from './agente.js';

const AHORA = new Date('2026-10-20T14:00:00Z');

const CORPUS: Record<string, string> = {
  'plan.md': '# Elija su plan\n\nEn esta pantalla aparece el botón Continuar con tarjetas de plan Esencial y Completo. Marque una tarjeta de plan y pulse Continuar.',
  'firma.md': '# Revise y firme\n\nEn esta pantalla aparece el campo Código de firma y el botón Firmar contrato. Escriba el codigo recibido por mensaje.',
  'general.md': '# Carencias\n\nLa carencia por cáncer es de 180 días desde el inicio de la vigencia de la póliza.',
  'otro.md': '# Pantalla del perfil\n\nEn esta pantalla del otro perfil aparece el botón Verificar teléfono.',
  // Manual largo: varios fragmentos de unos 200 caracteres, para probar el tope.
  'largo.md': ['# Manual largo', ...Array.from({ length: 6 }, (_, i) => `Párrafo ${i + 1}: ${'texto de relleno del manual de la pantalla '.repeat(4)}fin ${i + 1}.`)].join('\n\n'),
};

const fuente = (id: string, ruta: string, extra: Record<string, unknown> = {}) => ({ id, titulo: `Documento ${id}`, version: 'v1', ruta, ...extra });

function configuracion(conocimiento: Record<string, unknown> = {}, perfiles: Record<string, unknown> = {}) {
  return validarConfiguracion(configuracionCruda(conocimiento, perfiles));
}
const config0 = () => configuracion();

function configuracionCruda(conocimiento: Record<string, unknown> = {}, perfiles: Record<string, unknown> = {}) {
  return {
    ...CONFIG_PRUEBA,
    conocimiento: {
      modo: 'rag',
      topK: 3,
      umbral: 0.3,
      exigirRespaldo: true,
      tamanoFragmento: 200,
      fuentes: [fuente('manual-plan', 'plan.md'), fuente('manual-firma', 'firma.md'), fuente('general', 'general.md'), fuente('manual-largo', 'largo.md')],
      paginas: [
        { id: 'plan', fuenteId: 'manual-plan' },
        { id: 'firma', fuenteId: 'manual-firma' },
        { id: 'largo', fuenteId: 'manual-largo' },
      ],
      ...conocimiento,
    },
    perfiles: {
      OTRO: {
        nombre: 'Otro perfil',
        conocimiento: { fuentes: [fuente('manual-otro', 'otro.md'), fuente('general', 'general.md')], paginas: [{ id: 'otro', fuenteId: 'manual-otro' }] },
      },
      ...perfiles,
    },
  };
}

/** Proveedor que registra el prompt de sistema y delega en el simulado. */
class ProveedorEspia implements ProveedorLLM {
  readonly nombre = 'espia';
  readonly sistemas: string[] = [];
  private readonly interno = new ProveedorSimulado();
  generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
    this.sistemas.push(peticion.sistema);
    return this.interno.generar(peticion);
  }
}

async function armar(config = configuracion(), indice: IndiceEnMemoria = new IndiceEnMemoria(null)) {
  const bitacora = new BitacoraEnMemoria();
  await cargarCorpus(config, { leer: async (ruta) => CORPUS[ruta] ?? '' }, indice, bitacora);
  const proveedor = new ProveedorEspia();
  const agente = new Agente({ config, proveedor, indice, memoria: new MemoriaEnProceso(), herramientas: new RegistroHerramientas(), bitacora, reloj: () => AHORA });
  return { agente, indice, bitacora, proveedor, config };
}

let contador = 0;
const idConv = () => `conv_pagina_${String(++contador).padStart(4, '0')}`;

describe('contexto de página: página válida', () => {
  it('el manual entra como [1], con la frase de pantalla, y cuenta como respaldo de origen «pagina»', async () => {
    const { agente, proveedor } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    const sistema = proveedor.sistemas[0]!;
    expect(sistema).toContain('PANTALLA ACTUAL');
    expect(sistema).toContain('el documento [1] del RESPALDO DOCUMENTAL');
    expect(sistema).toMatch(/\[1\] Documento: «Documento manual-plan» \(versión v1\)\n/);
    expect(sistema).toContain('botón Continuar');
    expect(sistema.indexOf('PANTALLA ACTUAL')).toBeLessThan(sistema.indexOf('INICIO DE RESPALDO DOCUMENTAL'));
    expect(r.respaldo[0]).toEqual({ fuenteId: 'manual-plan', titulo: 'Documento manual-plan', version: 'v1', puntaje: 1, origen: 'pagina' });
    expect(r.avisos).not.toContain('pagina_desconocida');
  });

  it('una pregunta fuera de la página sigue trayendo el top-K de otra fuente', async () => {
    const { agente, proveedor } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la carencia por cáncer?', pagina: 'plan', canal: 'web' });
    expect(proveedor.sistemas[0]).toContain('180 días');
    expect(r.respaldo.map((x) => `${x.fuenteId}:${x.origen}`)).toEqual(['manual-plan:pagina', 'general:busqueda']);
  });

  it('una pregunta sobre la pantalla (deíctico) sin coincidencias de búsqueda responde desde el manual', async () => {
    const { agente, bitacora, proveedor } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(r.avisos).not.toContain('sin_respaldo');
    expect(bitacora.eventos.some((e) => e.tipo === 'sin_respaldo')).toBe(false);
    expect(r.respaldo).toHaveLength(1);
    expect(r.respaldo[0]).toMatchObject({ origen: 'pagina' });
    // El manual es todo el respaldo: la frase no remite a «el resto» y lo demás queda sin respaldo.
    expect(proveedor.sistemas[0]).not.toContain('use el resto del respaldo');
    expect(proveedor.sistemas[0]).toContain('SIN RESPALDO DOCUMENTAL PARA LO DEMÁS');
    // Sin página, esa misma pregunta sí queda sin respaldo.
    const sin = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', canal: 'web' });
    expect(sin.avisos).toContain('sin_respaldo');
  });

  it('una pregunta ajena (sin top-K y sin deíctico) sigue en sin_respaldo aunque la página sea válida', async () => {
    const { agente, bitacora, proveedor } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la tasa de interés del crédito hipotecario?', pagina: 'plan', canal: 'web' });
    expect(r.avisos).toContain('sin_respaldo');
    expect(r.texto).toContain(config0().mensajes.sinRespaldo);
    expect(r.respaldo).toEqual([]);
    expect(proveedor.sistemas[0]).not.toContain('botón Continuar');
    // La página fue válida, y la bitácora lo dice (solo el id), sin texto.
    expect(bitacora.eventos.find((e) => e.tipo === 'sin_respaldo')?.pagina).toBe('plan');
    expect(JSON.stringify(bitacora.eventos)).not.toContain('hipotecario');
  });

  it('una pregunta con coincidencias en el top-K responde aunque no tenga deíctico', async () => {
    const { agente } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la carencia por cáncer?', pagina: 'firma', canal: 'web' });
    expect(r.avisos).not.toContain('sin_respaldo');
    expect(r.respaldo.map((x) => x.origen)).toEqual(['pagina', 'busqueda']);
  });

  it('el manual de otra página no se cuela', async () => {
    const { agente, proveedor } = await armar();
    await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(proveedor.sistemas[0]).not.toContain('Código de firma');
  });

  it('la bitácora lleva solo el id validado y ningún texto', async () => {
    const { agente, bitacora } = await armar();
    await agente.responder({ conversacionId: idConv(), texto: 'TEXTO-SECRETO-DEL-MENSAJE en esta pantalla', pagina: 'firma', canal: 'web' });
    const atendido = bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido');
    expect(atendido?.pagina).toBe('firma');
    expect(JSON.stringify(bitacora.eventos)).not.toContain('TEXTO-SECRETO');
  });

  it('con tope de 500 caracteres inyecta fragmentos completos, avisa y nunca lo supera', async () => {
    const config = configuracion({ maxCaracteresPagina: 500 });
    const { agente, indice, bitacora } = await armar(config);
    const todos = await indice.fragmentosDeFuente(coleccionDe(config, null), 'manual-largo', 20);
    expect(todos.reduce((s, f) => s + f.texto.length, 0)).toBeGreaterThan(500);
    const r = await agente.responder({ conversacionId: idConv(), texto: 'zzz qqq xxx acá', pagina: 'largo', canal: 'web' });
    expect(r.avisos).toContain('pagina_recortada');
    const ids = bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')?.fragmentos ?? [];
    const inyectados = todos.filter((f) => ids.includes(f.id));
    expect(inyectados.length).toBeGreaterThan(0);
    expect(inyectados.length).toBeLessThan(todos.length);
    expect(inyectados.reduce((s, f) => s + f.texto.length, 0)).toBeLessThanOrEqual(500);
  });

  it('con el tope por omisión (4000) el manual corto no se recorta', async () => {
    const { agente } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(r.avisos).not.toContain('pagina_recortada');
  });
});

describe('contexto de página: fallos y límites del manual', () => {
  class IndiceManual extends IndiceEnMemoria {
    pedidos: number[] = [];
    constructor(private readonly manual: () => Promise<Fragmento[]>) {
      super(null);
    }
    override async fragmentosDeFuente(_c: string, _f: string, limite: number): Promise<Fragmento[]> {
      this.pedidos.push(limite);
      return this.manual();
    }
  }
  const trozo = (i: number, largo: number): Fragmento => ({ id: `m${i}`, coleccion: 'x', fuenteId: 'manual-plan', fuenteTitulo: 'Manual plan', fuenteVersion: 'v1', orden: i, texto: 'x'.repeat(largo) });

  it('si falla la lectura del manual: aviso pagina_error, sin pagina en la bitácora, y el top-K se conserva', async () => {
    const indice = new IndiceManual(async () => {
      throw new Error('boom lectura');
    });
    const { agente, bitacora } = await armar(configuracion(), indice);
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la carencia por cáncer?', pagina: 'plan', canal: 'web' });
    expect(r.avisos).toContain('pagina_error');
    expect(r.avisos).not.toContain('indice_error');
    expect(r.texto).toContain('180 días');
    expect(r.respaldo.map((x) => x.origen)).toEqual(['busqueda']);
    expect(bitacora.eventos.some((e) => e.tipo === 'error_modelo' && e.codigo === 'pagina')).toBe(true);
    expect(bitacora.eventos.every((e) => e.pagina === undefined)).toBe(true);
  });

  it('si falla la búsqueda después de una página correcta, la página sigue sirviendo con aviso indice_error', async () => {
    const indice = new IndiceEnMemoria(null);
    indice.buscar = async () => {
      throw new Error('boom búsqueda');
    };
    const { agente, bitacora } = await armar(configuracion(), indice);
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(r.avisos).toContain('indice_error');
    expect(r.avisos).not.toContain('pagina_error');
    expect(r.respaldo[0]).toMatchObject({ fuenteId: 'manual-plan', origen: 'pagina' });
    expect(bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')?.pagina).toBe('plan');
  });

  it('si el primer fragmento supera el tope no se inyecta nada y la bitácora no dice que hubo página', async () => {
    const indice = new IndiceManual(async () => [trozo(0, 600)]);
    const { agente, bitacora } = await armar(configuracion({ maxCaracteresPagina: 500 }), indice);
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(r.avisos).toContain('pagina_recortada');
    expect(r.respaldo.every((x) => x.origen === 'busqueda')).toBe(true);
    expect(bitacora.eventos.every((e) => e.pagina === undefined)).toBe(true);
  });

  it('pide un fragmento de más al índice y avisa pagina_recortada si llega, sin pasar de 20', async () => {
    const indice = new IndiceManual(async () => Array.from({ length: 21 }, (_, i) => trozo(i, 10)));
    const { agente, bitacora } = await armar(configuracion(), indice);
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(indice.pedidos).toEqual([21]);
    expect(r.avisos).toContain('pagina_recortada');
    expect(bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')?.fragmentos?.filter((id) => id.startsWith('m'))).toHaveLength(20);
  });
});

describe('contexto de página: valor desconocido o malformado', () => {
  const valores: Array<[string, unknown]> = [
    ['id inexistente con forma válida', 'no-existe'],
    ['forma inválida con texto secreto', 'TEXTO-SECRETO-PAGINA'],
    ['no es una cadena (número)', 123],
    ['no es una cadena (objeto)', { id: 'plan' }],
    ['cadena vacía', ''],
  ];
  it.each(valores)('%s: aviso pagina_desconocida, respuesta normal y el valor no aparece en el prompt ni en la bitácora', async (_nombre, valor) => {
    const { agente, proveedor, bitacora } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la carencia por cáncer?', pagina: valor as string, canal: 'web' });
    expect(r.avisos).toContain('pagina_desconocida');
    expect(r.texto).toContain('180 días');
    expect(r.respaldo.every((x) => x.origen === 'busqueda')).toBe(true);
    const crudo = typeof valor === 'string' ? valor : JSON.stringify(valor);
    if (crudo.length > 2) {
      expect(proveedor.sistemas[0]).not.toContain(crudo);
      expect(JSON.stringify(bitacora.eventos)).not.toContain(crudo);
    }
    expect(proveedor.sistemas[0]).not.toContain('PANTALLA ACTUAL');
    expect(bitacora.eventos.every((e) => e.pagina === undefined)).toBe(true);
  });

  it('una página de otro perfil es desconocida, y la del perfil solo vale en ese perfil', async () => {
    const { agente } = await armar();
    const a = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'otro', canal: 'web' });
    expect(a.avisos).toContain('pagina_desconocida');
    const b = await agente.responder({ conversacionId: idConv(), perfilId: 'OTRO', texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(b.avisos).toContain('pagina_desconocida');
    const c = await agente.responder({ conversacionId: idConv(), perfilId: 'OTRO', texto: '¿Qué hago acá?', pagina: 'otro', canal: 'web' });
    expect(c.avisos).not.toContain('pagina_desconocida');
    expect(c.respaldo[0]).toMatchObject({ fuenteId: 'manual-otro', origen: 'pagina' });
  });

  it('null y ausente no generan aviso', async () => {
    const { agente } = await armar();
    const a = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la carencia por cáncer?', pagina: null, canal: 'web' });
    const b = await agente.responder({ conversacionId: idConv(), texto: '¿Cuál es la carencia por cáncer?', canal: 'web' });
    expect(a.avisos).toEqual([]);
    expect(b.avisos).toEqual([]);
  });
});

describe('contexto de página: sin `pagina` el comportamiento es el de siempre', () => {
  it('el prompt es byte a byte el de armarPrompt con el top-K de la búsqueda, y el respaldo es solo de búsqueda', async () => {
    const { agente, proveedor, indice, config } = await armar();
    const texto = '¿Cuál es la carencia por cáncer?';
    const r = await agente.responder({ conversacionId: idConv(), texto, canal: 'web' });
    const efectiva = resolverConfiguracion(config, null);
    const buscados = await indice.buscar(texto, { coleccion: coleccionDe(config, null), topK: efectiva.conocimiento.topK, umbral: efectiva.conocimiento.umbral });
    const esperado = armarPrompt({ config: efectiva, ahora: AHORA, fragmentos: buscados, orientacion: { facetas: {} }, canal: 'web' });
    expect(proveedor.sistemas[0]).toBe(esperado);
    expect(esperado).not.toContain('PANTALLA ACTUAL');
    expect(r.respaldo).toEqual(buscados.map((f) => ({ fuenteId: f.fuenteId, titulo: f.fuenteTitulo, version: f.fuenteVersion, puntaje: f.puntaje, origen: 'busqueda' })));
  });
});

describe('contexto de página: validación de la configuración', () => {
  const detalles = (fn: () => unknown): string[] => {
    try {
      fn();
    } catch (e) {
      if (e instanceof ErrorConfiguracion) return e.detalles;
      throw e;
    }
    return [];
  };

  it('acepta una configuración consistente', () => {
    expect(() => configuracion()).not.toThrow();
  });

  it('rechaza una fuente inexistente', () => {
    const d = detalles(() => configuracion({ paginas: [{ id: 'plan', fuenteId: 'no-existe' }] }));
    expect(d).toContain('conocimiento.paginas.plan: la fuente «no-existe» no existe en las fuentes de base');
  });

  it('rechaza una fuente interna', () => {
    const d = detalles(() =>
      configuracion({ fuentes: [fuente('manual-plan', 'plan.md', { visibilidad: 'interno' })], paginas: [{ id: 'plan', fuenteId: 'manual-plan' }] }, { OTRO: { nombre: 'x' } }),
    );
    expect(d).toContain('conocimiento.paginas.plan: la fuente «manual-plan» es interna y no se indexa en base');
  });

  it('rechaza un id repetido', () => {
    const d = detalles(() => configuracion({ paginas: [{ id: 'plan', fuenteId: 'manual-plan' }, { id: 'plan', fuenteId: 'manual-firma' }] }));
    expect(d).toContain('conocimiento.paginas: id «plan» repetido en base');
  });

  it('rechaza páginas con modo solo_prompt', () => {
    const d = detalles(() => configuracion({ modo: 'solo_prompt' }));
    expect(d).toContain('conocimiento.paginas: requiere modo rag en base');
  });

  it('nombra el perfil cuando la falla está en un perfil', () => {
    const d = detalles(() => configuracion({}, { OTRO: { nombre: 'Otro', conocimiento: { paginas: [{ id: 'x', fuenteId: 'otra-fuente' }] } } }));
    expect(d).toContain('conocimiento.paginas.x: la fuente «otra-fuente» no existe en las fuentes de OTRO');
  });

  it('rechaza un maxCaracteresPagina menor que tamanoFragmento + 200', () => {
    const d = detalles(() => configuracion({ tamanoFragmento: 900, maxCaracteresPagina: 1000 }));
    expect(d.some((m) => m.startsWith('conocimiento.maxCaracteresPagina: 1000 es menor que tamanoFragmento + 200 (1100) en base'))).toBe(true);
    expect(() => configuracion({ tamanoFragmento: 900, maxCaracteresPagina: 1100 })).not.toThrow();
  });

  it('rechaza un perfil que redefine fuentes pero hereda las páginas de la base', () => {
    const d = detalles(() => configuracion({}, { SOLOGENERAL: { nombre: 'Solo general', conocimiento: { fuentes: [fuente('general', 'general.md')] } } }));
    expect(d).toContain('conocimiento.paginas.plan: la fuente «manual-plan» no existe en las fuentes de SOLOGENERAL');
  });

  it('rotula el perfil por omisión en vez de «base»', () => {
    const d = detalles(() => configuracion({ paginas: [{ id: 'plan', fuenteId: 'no-existe' }] }, { OTRO: { nombre: 'Otro' } }));
    expect(d).toContain('conocimiento.paginas.plan: la fuente «no-existe» no existe en las fuentes de base');
    const conDefecto = detalles(() => validarConfiguracion({ ...configuracionCruda({ paginas: [{ id: 'plan', fuenteId: 'no-existe' }] }, { OTRO: { nombre: 'Otro' } }), perfilPorDefecto: 'OTRO' }));
    expect(conDefecto.some((m) => m.includes('perfil por omisión OTRO'))).toBe(true);
  });

  it('rechaza un patrón de id inválido y campos desconocidos', () => {
    expect(() => configuracion({ paginas: [{ id: 'Plan_X', fuenteId: 'manual-plan' }] })).toThrow(ErrorConfiguracion);
    expect(() => configuracion({ paginas: [{ id: 'plan', fuenteId: 'manual-plan', extra: 1 }] })).toThrow(ErrorConfiguracion);
    expect(() => configuracion({ maxCaracteresPagina: 100 })).toThrow(ErrorConfiguracion);
  });
});

describe('contexto de página: índice y corpus', () => {
  const frag = (id: string, fuenteId: string, orden: number, coleccion = 'c') => ({ id, coleccion, fuenteId, fuenteTitulo: 'T', fuenteVersion: 'v1', orden, texto: `texto ${id}` });

  it('fragmentosDeFuente filtra por colección y fuente, ordena por orden y respeta el límite', async () => {
    const indice = new IndiceEnMemoria(null);
    await indice.indexar([frag('c2', 'f', 2), frag('c0', 'f', 0), frag('c1', 'f', 1), frag('o0', 'otra', 0), frag('x0', 'f', 0, 'otra-coleccion')]);
    expect((await indice.fragmentosDeFuente('c', 'f', 20)).map((f) => f.id)).toEqual(['c0', 'c1', 'c2']);
    expect((await indice.fragmentosDeFuente('c', 'f', 2)).map((f) => f.id)).toEqual(['c0', 'c1']);
    expect(await indice.fragmentosDeFuente('c', 'no-existe', 20)).toEqual([]);
    expect(await indice.fragmentosDeFuente('sin-coleccion', 'f', 20)).toEqual([]);
  });

  it('los comentarios HTML del manual no se indexan y los documentos sin comentarios no cambian', async () => {
    const config = configuracion();
    const conComentario = new IndiceEnMemoria(null);
    const sinComentario = new IndiceEnMemoria(null);
    const limpio = CORPUS['plan.md']!;
    const lector = (texto: string) => ({ leer: async (ruta: string) => (ruta === 'plan.md' ? texto : (CORPUS[ruta] ?? '')) });
    await cargarCorpus(config, lector(`<!-- plan | metadato\nde varias líneas -->\n${limpio}`), conComentario);
    await cargarCorpus(config, lector(limpio), sinComentario);
    const col = coleccionDe(config, null);
    const a = await conComentario.fragmentosDeFuente(col, 'manual-plan', 20);
    const b = await sinComentario.fragmentosDeFuente(col, 'manual-plan', 20);
    expect(a.map((f) => f.texto).join(' ')).not.toContain('metadato');
    expect(a.map((f) => f.texto)).toEqual(b.map((f) => f.texto));
    expect(a.map((f) => f.id)).toEqual(b.map((f) => f.id));
  });
});

describe('contexto de página: comentarios HTML del manual', () => {
  it('quita comentarios anidados por construcción y deja pasar el texto sin comentarios', () => {
    expect(quitarComentariosHtml('<!<!-- x -->-- texto -->resto')).toBe('resto');
    expect(quitarComentariosHtml('a <!-- uno --> b <!-- dos\nlíneas --> c')).toBe('a  b  c');
    expect(quitarComentariosHtml('sin comentarios')).toBe('sin comentarios');
  });
  it('un comentario sin cerrar queda a la vista (validar-config lo rechaza)', () => {
    expect(quitarComentariosHtml('hola <!-- sin cerrar')).toContain('<!--');
    expect(quitarComentariosHtml('hola --> suelto')).toContain('-->');
  });
});
