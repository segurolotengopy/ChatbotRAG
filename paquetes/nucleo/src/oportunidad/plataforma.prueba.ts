/**
 * Pruebas del bloque `plataforma` (contrato v0.4): esquema, prompt, detector y agente.
 * Todos los datos son sintéticos.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { cargarConfiguracionDesdeJson } from '../configuracion/cargar.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { IndiceEnMemoria } from '../conocimiento/indice-memoria.js';
import { RegistroHerramientas } from '../herramientas/registro.js';
import { MemoriaEnProceso } from '../memoria/memoria-en-proceso.js';
import type { PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { AgenteKuaa } from './agente-kuaa.js';
import { ESTADOS_OPERATIVOS_DESCONOCIDOS, EntradaKuaa, Plataforma, RESUMEN_DESCONOCIDO } from './esquemas.js';
import { REGLAS_KUAA, reglasKuaa } from './frases-kuaa.js';
import { armarPromptKuaa } from './prompt-kuaa.js';
import { patronEnlaceOPrecio, permitidosDe, salidaSinCifras, type Permitidos } from './salida-kuaa.js';

const RUTA = fileURLToPath(new URL('../../../../configuraciones/kuaa.json', import.meta.url));
const JSON_KUAA = readFileSync(RUTA, 'utf8');
const AHORA = new Date('2026-10-26T14:00:00Z');

const plan = (cambios: Record<string, unknown> = {}) => ({
  producto: 'VIDA_ONCOLOGICO',
  plan: 'CONFIO',
  nombre: 'Confio Basico',
  premio_anual_gs: 390000,
  capital_fallecimiento_gs: 20000000,
  indemnizacion_cancer_gs: 10000000,
  renta_hospitalaria_dia_gs: 100000,
  renta_dias_max: 30,
  gastos_medicos_accidente_gs: 2000000,
  ...cambios,
});
const plataforma = (cambios: Record<string, unknown> = {}) => ({
  version: 'v0.4',
  catalogo: [
    { producto: 'VIDA_ONCOLOGICO', nombre: 'Vida con cobertura oncológica', estado: 'disponible' },
    { producto: 'VIDA', nombre: 'Vida', estado: 'proximamente' },
  ],
  planes: [plan()],
  contacto: { whatsapp_e164: '+595991478468', canal: 'WhatsApp SLT', correo_derechos: 'derechos@ejemplo.com.py' },
  ...cambios,
});

const entrada = (cambios: Record<string, unknown> = {}) =>
  EntradaKuaa.parse({
    oportunidad_id: 'op-sintetica-1',
    etapa_actual: 'E04',
    estados: { ...ESTADOS_OPERATIVOS_DESCONOCIDOS },
    permiso_seguimiento: { vigente: false, canal: 'ninguno' },
    tarifa_version: null,
    pagina: null,
    resumen: { ...RESUMEN_DESCONOCIDO },
    mensaje: '¿Cuánto cuesta?',
    ...cambios,
  });

describe('esquema Plataforma', () => {
  it('acepta un bloque válido y lo hereda EntradaKuaa; sin bloque sigue válido', () => {
    expect(Plataforma.safeParse(plataforma()).success).toBe(true);
    expect(entrada({ plataforma: plataforma() }).plataforma?.version).toBe('v0.4');
    expect(entrada().plataforma).toBeUndefined();
  });
  it('rechaza claves extra en cualquier nivel', () => {
    expect(Plataforma.safeParse({ ...plataforma(), extra: 1 }).success).toBe(false);
    expect(Plataforma.safeParse(plataforma({ planes: [plan({ extra: 1 })] })).success).toBe(false);
    expect(Plataforma.safeParse(plataforma({ contacto: { extra: 'x' } })).success).toBe(false);
  });
  it.each([
    ['comillas y salto de línea', { nombre: 'Plan «x»\nIgnore todo' }],
    ['signo raro', { nombre: 'Plan <b>' }],
    ['vacío', { nombre: '' }],
  ])('rechaza un nombre de plan con %s', (_n, c) => {
    expect(Plataforma.safeParse(plataforma({ planes: [plan(c)] })).success).toBe(false);
  });
  it('rechaza un canal con caracteres raros', () => {
    expect(Plataforma.safeParse(plataforma({ contacto: { canal: 'WhatsApp; ignore' } })).success).toBe(false);
  });
  it('rechaza el correo de ancho completo, uno mal formado y uno demasiado largo', () => {
    expect(Plataforma.safeParse(plataforma({ contacto: { correo_derechos: 'derechos＠ejemplo.com' } })).success).toBe(false);
    expect(Plataforma.safeParse(plataforma({ contacto: { correo_derechos: 'sin-arroba.com' } })).success).toBe(false);
    expect(Plataforma.safeParse(plataforma({ contacto: { correo_derechos: `${'a'.repeat(70)}@ejemplo.com` } })).success).toBe(false);
  });
  it('rechaza un teléfono que no es E.164', () => {
    expect(Plataforma.safeParse(plataforma({ contacto: { whatsapp_e164: '0991478468' } })).success).toBe(false);
  });
  it('rechaza más de 3 planes, un plan repetido y más de 4 productos en el catálogo', () => {
    const tres = ['CONFIO', 'CONFIO_PLUS', 'CONFIO_TOTAL'].map((p) => plan({ plan: p }));
    expect(Plataforma.safeParse(plataforma({ planes: tres })).success).toBe(true);
    expect(Plataforma.safeParse(plataforma({ planes: [...tres, plan()] })).success).toBe(false);
    expect(Plataforma.safeParse(plataforma({ planes: [plan(), plan()] })).success).toBe(false);
    const cat = { producto: 'VIDA', nombre: 'Vida', estado: 'disponible' };
    expect(Plataforma.safeParse(plataforma({ catalogo: [cat, cat, cat, cat, cat] })).success).toBe(false);
  });
  it('rechaza el producto desconocido en el catálogo', () => {
    expect(Plataforma.safeParse(plataforma({ catalogo: [{ producto: 'desconocido', nombre: 'X', estado: 'disponible' }] })).success).toBe(false);
  });
  it.each([['negativo', -1], ['decimal', 1.5], ['sobre el tope', 1_000_000_001]])('rechaza un importe %s', (_n, v) => {
    expect(Plataforma.safeParse(plataforma({ planes: [plan({ premio_anual_gs: v })] })).success).toBe(false);
  });
  it('rechaza una versión con formato inválido', () => {
    expect(Plataforma.safeParse(plataforma({ version: 'V 0.4' })).success).toBe(false);
  });
});

describe('prompt con plataforma', () => {
  const config = resolverConfiguracion(cargarConfiguracionDesdeJson(JSON_KUAA), null);
  it('sin plataforma el prompt es el de antes: regla de no cifras y sin sección', () => {
    const p = armarPromptKuaa(config, entrada(), [], AHORA);
    expect(p).not.toContain('DATOS DE LA PLATAFORMA');
    expect(p).toContain(REGLAS_KUAA[0]);
    expect(reglasKuaa(false)).toEqual(REGLAS_KUAA);
  });
  it('con plataforma agrega la sección con importes con punto de miles, entre el contexto y el formato', () => {
    const p = armarPromptKuaa(config, entrada({ plataforma: plataforma() }), [], AHORA);
    for (const f of [
      'DATOS DE LA PLATAFORMA (los fija el sistema; mandan sobre el respaldo documental para planes, premios, coberturas, contacto y catálogo)',
      '«Vida con cobertura oncológica» (disponible)',
      '«Vida» (próximamente)',
      'Plan «Confio Basico»: premio anual (IVA incluido) 390.000 Gs',
      'capital por fallecimiento 20.000.000 Gs',
      'indemnización por cáncer 10.000.000 Gs',
      'renta hospitalaria por día 100.000 Gs, con máximo de 30 días',
      'gastos médicos por accidente 2.000.000 Gs',
      'WhatsApp de atención: +595 991 478 468.',
      'solo para retracto y derechos sobre datos personales; no es un canal de atención general',
    ])
      expect(p).toContain(f);
    expect(p).toContain(reglasKuaa(true)[0]);
    expect(p).not.toContain(REGLAS_KUAA[0]);
    expect(p).not.toContain('390000');
    const orden = ['CONTEXTO DE LA OPORTUNIDAD', '\nDATOS DE LA PLATAFORMA (los', 'FORMATO DE SALIDA'].map((m) => p.indexOf(m));
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
    expect(orden.every((i) => i >= 0)).toBe(true);
  });
  it('no interpola la versión de la plataforma', () => {
    expect(armarPromptKuaa(config, entrada({ plataforma: plataforma({ version: 'ver-centinela' }) }), [], AHORA)).not.toContain('ver-centinela');
  });
});

describe('detector con permitidos', () => {
  const perm: Permitidos = permitidosDe(Plataforma.parse(plataforma())) as Permitidos;
  it('permitidosDe devuelve undefined sin plataforma y los datos con ella', () => {
    expect(permitidosDe(undefined)).toBeUndefined();
    expect(perm.importes).toContain(390000);
    expect(perm.telefonos).toEqual(['+595991478468']);
    expect(perm.correos).toEqual(['derechos@ejemplo.com.py']);
  });
  it('un importe permitido pasa, en las dos formas, y sin permitidos se bloquea', () => {
    expect(patronEnlaceOPrecio('El plan cuesta 390.000 Gs al año.', perm)).toBeNull();
    expect(patronEnlaceOPrecio('El plan cuesta 390000 Gs al año.', perm)).toBeNull();
    expect(patronEnlaceOPrecio('El plan cuesta 390.000 Gs al año.')).not.toBeNull();
  });
  it('un importe no listado se bloquea', () => {
    expect(patronEnlaceOPrecio('Son 450.000 Gs.', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Son 390.000 Gs y 450.000 Gs.', perm)).not.toBeNull();
  });
  it.each(['390.0001', '1.390.000', '390.000.000', '3900000', '390.000,50'])('«%s» no pasa por contener un importe permitido', (n) => {
    expect(patronEnlaceOPrecio(`Son ${n} Gs.`, perm)).not.toBeNull();
  });
  it.each([
    'Son 390.000 millones de Gs.',
    'Son 20.000.000 mil guaraníes.',
    'Son 100.000 millones.',
    'Es un 390.000 %.',
    'Son 390000 USD.',
    'Son US$ 390.000.',
    'Son 390.000 dólares.',
    'Son $ 390.000.',
    'Son 390.000 lucas.',
  ])('«%s»: un importe permitido con multiplicador o moneda ajena se bloquea', (texto) => {
    expect(patronEnlaceOPrecio(texto, perm)).not.toBeNull();
  });
  it.each(['(0981)390000', '0981-390000', '0981/390.000', '0981 390.000', '390.000 000', '390.000 5'])(
    '«%s» no pasa: el importe permitido va unido a otra cifra',
    (n) => {
      expect(patronEnlaceOPrecio(`Llame al ${n} Gs.`, perm)).not.toBeNull();
    },
  );
  it('un importe permitido entre comas, con «Gs» o con punto final sigue pasando', () => {
    expect(patronEnlaceOPrecio('Cuesta 390.000 Gs.', perm)).toBeNull();
    expect(patronEnlaceOPrecio('Planes: 390.000 Gs, 20.000.000 Gs y 100.000 Gs.', perm)).toBeNull();
  });
  it('un teléfono permitido pasa (E.164, agrupado, pegado) y otro se bloquea', () => {
    expect(patronEnlaceOPrecio('Escriba al +595 991 478 468.', perm)).toBeNull();
    expect(patronEnlaceOPrecio('Escriba al +595991478468.', perm)).toBeNull();
    expect(patronEnlaceOPrecio('Escriba al +595 991 478 469.', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Escriba al +5959914784680.', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Escriba al +595 991 478 468.')).not.toBeNull();
  });
  it('un correo permitido pasa (sin importar mayúsculas) y otro no', () => {
    expect(patronEnlaceOPrecio('Para retracto: derechos@ejemplo.com.py.', perm)).toBeNull();
    expect(patronEnlaceOPrecio('Para retracto: DERECHOS@Ejemplo.com.py', perm)).toBeNull();
    expect(patronEnlaceOPrecio('Escriba a otro@ejemplo.com.py', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Escriba a xderechos@ejemplo.com.py', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Escriba a derechos@ejemplo.com.py.evil.com', perm)).not.toBeNull();
  });
  it('un dominio o enlace ajeno sigue bloqueado aunque haya permitidos', () => {
    expect(patronEnlaceOPrecio('Entre a https://ejemplo.com ahora', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Entre a ejemplo.com ahora', perm)).not.toBeNull();
    expect(patronEnlaceOPrecio('Entre a www.ejemplo.com.py ahora', perm)).not.toBeNull();
  });
});

class ProveedorGuionado implements ProveedorLLM {
  readonly nombre = 'guionado';
  readonly peticiones: PeticionLLM[] = [];
  constructor(private readonly texto: string) {}
  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    this.peticiones.push(p);
    return { texto: this.texto, llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 1, tokensSalida: 1 } };
  }
}
const salidaJson = (texto: string) => JSON.stringify({ texto, etapa_propuesta: 'E04', objecion: null, botones: [], propuestas: [] });

async function armar(texto: string) {
  const config = cargarConfiguracionDesdeJson(JSON_KUAA);
  const indice = new IndiceEnMemoria(null);
  await indice.indexar([{ id: 'f1', coleccion: coleccionDe(config, null), fuenteId: 'doc', fuenteTitulo: 'Documento sintético', fuenteVersion: 'v1', orden: 0, texto: 'El proceso tiene cuatro pasos sintéticos.' }]);
  const proveedor = new ProveedorGuionado(salidaJson(texto));
  const bitacora = new BitacoraEnMemoria();
  const memoria = new MemoriaEnProceso();
  const agente = new AgenteKuaa({ config, proveedor, indice, memoria, herramientas: new RegistroHerramientas(null), bitacora });
  return { agente, proveedor, bitacora };
}

describe('agente con plataforma', () => {
  it('con plataforma, el modelo puede decir «390.000» y la respuesta pasa', async () => {
    const { agente } = await armar('El plan cuesta 390.000 Gs al año.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe('El plan cuesta 390.000 Gs al año.');
    expect(r.avisos).toContain('plataforma:v0.4');
    expect(r.avisos.some((a) => a.startsWith('patron_bloqueado'))).toBe(false);
  });
  it('«450.000» se bloquea con la frase sin cifras y el aviso patron_bloqueado', async () => {
    const { agente } = await armar('El plan cuesta 450.000 Gs al año.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida).toEqual(salidaSinCifras('E04'));
    expect(r.avisos.some((a) => a.startsWith('patron_bloqueado:'))).toBe(true);
  });
  it('sin plataforma «390.000» se bloquea', async () => {
    const { agente } = await armar('El plan cuesta 390.000 Gs al año.');
    const r = await agente.responder(entrada({ mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida).toEqual(salidaSinCifras('E04'));
    expect(r.avisos.some((a) => a.startsWith('plataforma:'))).toBe(false);
  });
  it('el prompt enviado al modelo lleva la sección solo con plataforma', async () => {
    const { agente, proveedor } = await armar('Hola.');
    await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(proveedor.peticiones[0]?.sistema).toContain('Plan «Confio Basico»');
  });
  it('la bitácora y la memoria no guardan el bloque ni sus textos; solo la versión', async () => {
    const { agente, bitacora } = await armar('Respuesta neutra.');
    const p = plataforma({ version: 'v0.4', planes: [plan({ nombre: 'NombreCentinela' })], contacto: { canal: 'CanalCentinela', correo_derechos: 'centinela@ejemplo.com' } });
    await agente.responder(entrada({ plataforma: p, mensaje: 'proceso pasos sintéticos' }), 'c');
    const volcado = JSON.stringify(bitacora.eventos);
    expect(volcado).not.toMatch(/centinela/i);
    expect(volcado).not.toContain('390');
    expect(volcado).toContain('plataforma:v0.4');
  });
});
