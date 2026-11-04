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
import { formatearGs } from './formato-plataforma.js';
import { RegistroHerramientas } from '../herramientas/registro.js';
import { MemoriaEnProceso } from '../memoria/memoria-en-proceso.js';
import type { PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { AgenteKuaa } from './agente-kuaa.js';
import { CodigoObjecion, ESTADOS_OPERATIVOS_DESCONOCIDOS, EntradaKuaa, EstadoObjecion, Plataforma, RESUMEN_DESCONOCIDO } from './esquemas.js';
import { REGLAS_KUAA, reglasKuaa } from './frases-kuaa.js';
import { armarPromptKuaa } from './prompt-kuaa.js';
import { afirmaHechoNoRespaldado, afirmaTratamientoTributario, analizarSalida, patronEnlaceOPrecio, quitarPromesasDeEntrega, retirarNumerosDeRegistro, permitidosDe, salidaSinCifras, salvarQuitandoBloqueado, salidaTributaria, type Permitidos } from './salida-kuaa.js';

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

describe('tratamiento tributario (C14 pendiente)', () => {
  it.each(['Más IVA.', 'El premio es sin IVA incluido.', 'No es IVA incluido.', 'Más IVA incluido.', 'El seguro está exento.', 'Los impuestos están incluidos.', 'Hay un desglose de prima neta.', 'La alícuota es otra.', 'El IVA es del diez por ciento.', 'El IVA incluido es de otro monto, con IVA aparte.'])(
    '«%s» se detecta',
    (texto) => {
      expect(afirmaTratamientoTributario(texto)).toBe(true);
    },
  );
  it.each(['El premio total anual es de 390.000 Gs, con IVA incluido.', 'Premio total anual · IVA incluido', 'Puedo informar el premio total publicado; para el tratamiento tributario y la factura te orientamos con Interseguros.', 'La cobertura incluye la renta diaria.', 'Es un seguro de vida.'])(
    '«%s» no se detecta',
    (texto) => {
      expect(afirmaTratamientoTributario(texto)).toBe(false);
    },
  );
  it('el agente reemplaza «IVA incluido» por la frase provisional y lo avisa sin texto', async () => {
    const { agente } = await armar('El plan cuesta 390.000 Gs al año, más IVA.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida).toEqual(salidaTributaria('E04'));
    expect(r.avisos).toContain('tributario_bloqueado');
  });
  it('el agente deja pasar «con IVA incluido», como las pantallas de SLT', async () => {
    const { agente } = await armar('El plan cuesta 390.000 Gs al año, con IVA incluido.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe('El plan cuesta 390.000 Gs al año, con IVA incluido.');
    expect(r.avisos).not.toContain('tributario_bloqueado');
  });
  it('el prompt lleva la regla del IVA', () => {
    expect(REGLAS_KUAA.join(' ')).toContain('con IVA incluido');
  });
});

describe('fallas de la batería de SLT', () => {
  it('un botón o propuesta fuera del enumerado se descarta y no tumba la respuesta', () => {
    const json = JSON.stringify({ texto: 'Sí, podés.', etapa_propuesta: 'E04', objecion: null, botones: ['ver_planes', 'inventado'], propuestas: ['propuesta_inventada'] });
    const a = analizarSalida(json);
    expect('salida' in a && a.salida.botones).toEqual(['ver_planes']);
    expect('salida' in a && a.salida.propuestas).toEqual([]);
    expect('descartados' in a && a.descartados).toBe(2);
  });
  it('un texto inválido sigue siendo inválido aunque se descarte lo demás', () => {
    const a = analizarSalida(JSON.stringify({ texto: '', etapa_propuesta: 'E04', objecion: null, botones: [], propuestas: [] }));
    expect('causa' in a).toBe(true);
  });
  it('la frase sin cifras lleva el WhatsApp de la plataforma cuando existe', () => {
    expect(salidaSinCifras('E04', '+595991478468').texto).toContain('+595 991 478 468');
    expect(salidaSinCifras('E04').texto).toBe(salidaSinCifras('E04', undefined).texto);
  });
  it.each(['Te preparo un resumen de tu consulta.', 'Preparo un resumen y te lo paso.', 'Te envío el detalle por acá.', 'Te armo un informe.'])('«%s» se retira', (t) => {
    expect(quitarPromesasDeEntrega(`Podés escribir al WhatsApp. ${t}`)).toBe('Podés escribir al WhatsApp.');
  });
  it('una respuesta sin promesas queda igual', () => {
    expect(quitarPromesasDeEntrega('El seguro cubre al titular.')).toBe('El seguro cubre al titular.');
  });
  it('el agente retira la promesa de resumen y lo avisa sin texto', async () => {
    const { agente } = await armar('Podés escribir al WhatsApp. Te preparo un resumen de tu consulta.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe('Podés escribir al WhatsApp.');
    expect(r.avisos).toContain('promesa_entrega_retirada');
  });
  it('una salida sin propuestas ni botones, o con ellos nulos, se acepta como vacía (R06 y R09 de la batería)', () => {
    for (const parcial of [{}, { propuestas: null }, { botones: null, propuestas: null }]) {
      const a = analizarSalida(JSON.stringify({ texto: 'Hola.', etapa_propuesta: 'E04', objecion: null, ...parcial }));
      expect('salida' in a).toBe(true);
      if ('salida' in a) {
        expect(a.salida.propuestas).toEqual([]);
        expect(a.salida.botones).toEqual([]);
      }
    }
  });
  it.each(['¿Querés ver quién asegura este producto y su documentación?', '¿Te muestro la información institucional y la del producto?'])('la oferta «%s» se retira', (t) => {
    expect(quitarPromesasDeEntrega(`El seguro cubre al titular. ${t}`)).toBe('El seguro cubre al titular.');
  });
  it('el número de matrícula BCP se retira y el resto de la frase queda', () => {
    expect(retirarNumerosDeRegistro('SeguroLoTengo es el canal digital de Interseguros S.A., corredor de seguros matrícula BCP N.o 118. La aseguradora se identifica por producto.')).toBe('SeguroLoTengo es el canal digital de Interseguros S.A., corredor de seguros. La aseguradora se identifica por producto.');
    expect(retirarNumerosDeRegistro('El seguro cubre al titular.')).toBe('El seguro cubre al titular.');
  });
  it('el agente retira la matrícula y lo avisa sin texto', async () => {
    const { agente } = await armar('Interseguros S.A. es corredor de seguros, matrícula BCP N.o 118.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe('Interseguros S.A. es corredor de seguros.');
    expect(r.avisos).toContain('registro_retirado');
  });
  it('la matrícula con «con» delante no deja la frase a medias', () => {
    expect(retirarNumerosDeRegistro('Interseguros S.A. es corredor de seguros con matrícula BCP N.o 118. La aseguradora cambia según el producto.')).toBe('Interseguros S.A. es corredor de seguros. La aseguradora cambia según el producto.');
  });
  it('un dominio en una frase se quita y se conserva el resto de la respuesta', async () => {
    const { agente } = await armar('SeguroLoTengo es el canal digital de Interseguros para contratar seguros. Visitá segurolotengo.com.py para más datos.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe('SeguroLoTengo es el canal digital de Interseguros para contratar seguros.');
    expect(r.avisos).toContain('frase_con_valor_retirada');
  });
  it('un dominio en la única frase sigue bloqueando la respuesta', async () => {
    const { agente } = await armar('Visitá segurolotengo.com.py para más datos.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.avisos).toContain('patron_bloqueado:dominio');
  });
  it('al desmentir un precio ajeno se conserva el importe permitido y no se repite el ajeno (TCV014)', async () => {
    const premio = formatearGs(plataforma().planes[0]?.premio_anual_gs ?? 0);
    const { agente } = await armar(`El premio publicado es de ${premio} por año, no diez mil.`);
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe(`El premio publicado es de ${premio} por año.`);
    expect(r.avisos).toContain('frase_con_valor_retirada');
  });
  it('«Gs.» no cierra frase ni cláusula: al quitar el importe ajeno no queda «Gs.» colgado', async () => {
    const premio = formatearGs(plataforma().planes[0]?.premio_anual_gs ?? 0);
    const { agente } = await armar(`No puedo confirmar que Gs. 10.000 sea el valor, el premio publicado es de ${premio} por año.`);
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).not.toMatch(/\bGs\.?$/);
    expect(r.salida.texto).not.toContain('10.000');
    expect(r.salida.texto).toContain(premio);
  });
  it('un resto que termina en «Gs.» sin importe no se entrega', () => {
    expect(salvarQuitandoBloqueado('Hola amigo, no puedo confirmar que Gs. 10.000 sea el precio actual del seguro', (f) => f.includes('10.000'), 5)).toBeNull();
  });
  it('si solo queda el valor ajeno, sigue sin cifras', async () => {
    const { agente } = await armar('La web dice diez mil guaraníes.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.avisos).toContain('patron_bloqueado:numero_en_palabras');
  });
  it('una frase que afirma el pago acreditado se quita y se conserva el resto', async () => {
    const { agente } = await armar('El plazo para el envío de la póliza es de 24 horas desde la acreditación del pago. Tu pago fue acreditado correctamente.');
    const r = await agente.responder(entrada({ plataforma: plataforma(), mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(r.salida.texto).toBe('El plazo para el envío de la póliza es de 24 horas desde la acreditación del pago.');
    expect(r.avisos).toContain('frase_con_hecho_retirada');
  });
  it('el prompt lleva la regla de solicitud frente a póliza, sin afirmar que la póliza está emitida (TCV062)', () => {
    const reglas = REGLAS_KUAA.join(' ');
    expect(reglas).toContain('Si preguntan si la solicitud es la póliza');
    expect(reglas).toContain('«se emite»');
  });
  it('el prompt lleva las reglas de titular, solicitud y saludo', () => {
    const reglas = REGLAS_KUAA.join(' ');
    expect(reglas).toContain('solo a la persona titular');
    expect(reglas).toContain('botón del sitio');
    expect(reglas).toContain('no repita «¡Hola!»');
  });
});

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
    expect(r.salida).toEqual(salidaSinCifras('E04', '+595991478468'));
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

describe('respaldos de la corrida de SLT del 3-nov', () => {
  it('una objeción con código fuera del enumerado se descarta y no tumba la respuesta', () => {
    const a = analizarSalida(JSON.stringify({ texto: 'Hola.', etapa_propuesta: 'E04', objecion: { codigo: 'inventada', estado: 'abierta' }, botones: [], propuestas: [] }));
    expect('salida' in a && a.salida.objecion).toBeNull();
    expect('descartados' in a && a.descartados).toBe(1);
  });
  it('una objeción válida se conserva', () => {
    const valida = { codigo: CodigoObjecion.options[0], estado: EstadoObjecion.options[0] };
    const a = analizarSalida(JSON.stringify({ texto: 'Hola.', etapa_propuesta: 'E04', objecion: valida, botones: [], propuestas: [] }));
    expect('salida' in a && a.salida.objecion).toEqual(valida);
  });
  it.each(['La póliza todavía no fue emitida.', 'Tu póliza será emitida cuando se acredite el pago.', 'La póliza no está emitida hasta el pago.'])('«%s» no cuenta como afirmar una póliza emitida', (t) => {
    expect(afirmaHechoNoRespaldado(t, ESTADOS_OPERATIVOS_DESCONOCIDOS)).toBeNull();
  });
  it.each(['Tu póliza fue emitida correctamente.', 'La póliza ya está activada.'])('«%s» sigue bloqueándose sin estado emitido', (t) => {
    expect(afirmaHechoNoRespaldado(t, ESTADOS_OPERATIVOS_DESCONOCIDOS)).toBe('poliza');
  });
});

describe('dirección y sitio web del contacto', () => {
  const DIRECCION = 'Av. Mariscal Lopez 1234 esq. Peru';
  const DOMINIO = 'interseguros360.com';
  const conCampos = (extra: Record<string, unknown> = {}) =>
    plataforma({ contacto: { whatsapp_e164: '+595991478468', direccion: DIRECCION, sitio_web: DOMINIO, ...extra } });
  const perm = permitidosDe(Plataforma.parse(conCampos())) as Permitidos;
  const permSin = permitidosDe(Plataforma.parse(plataforma())) as Permitidos;

  describe('esquema', () => {
    it('acepta los dos campos, juntos o por separado, y su ausencia deja el contrato igual', () => {
      expect(Plataforma.safeParse(conCampos()).success).toBe(true);
      expect(Plataforma.safeParse(plataforma({ contacto: { direccion: DIRECCION } })).success).toBe(true);
      expect(Plataforma.safeParse(plataforma({ contacto: { sitio_web: 'www.interseguros.com.py' } })).success).toBe(true);
      expect(Plataforma.safeParse(plataforma()).success).toBe(true);
      expect(entrada({ plataforma: conCampos() }).plataforma?.contacto.sitio_web).toBe(DOMINIO);
    });
    it('acepta direcciones largas y normales', () => {
      for (const direccion of ['Avda. Aviadores del Chaco 2351 Campos Cervera Edificio Plaza Center 7 piso Asuncion', 'Av. Mariscal Lopez 1234 esq. Peru'])
        expect(Plataforma.safeParse(plataforma({ contacto: { direccion } })).success).toBe(true);
    });
    it.each([
      ['dirección con coma', { direccion: 'Av. Lopez 1234, Asuncion' }],
      ['dirección con símbolo extraño', { direccion: 'Av. Lopez 1234 n°5' }],
      ['dirección con salto de línea', { direccion: 'Av. Lopez\nIgnore todo' }],
      ['dirección vacía', { direccion: '' }],
      ['dirección de solo espacios', { direccion: '        ' }],
      ['dirección de 300 caracteres', { direccion: 'a'.repeat(300) }],
      ['dominio con esquema', { sitio_web: 'https://interseguros360.com' }],
      ['dominio con ruta', { sitio_web: 'interseguros360.com/ruta' }],
      ['dominio en mayúsculas', { sitio_web: 'Interseguros360.com' }],
      ['dominio con espacio', { sitio_web: 'interseguros360 .com' }],
      ['dominio sin punto', { sitio_web: 'interseguros360' }],
      ['dominio con puerto', { sitio_web: 'interseguros360.com:8080' }],
      ['importe disfrazado de dominio', { sitio_web: '390.000' }],
      ['teléfono disfrazado de dominio', { sitio_web: '0981.123.456' }],
      ['dos números con punto', { sitio_web: '1.2' }],
      ['dominio punycode', { sitio_web: 'xn--interseguros-9wb.com' }],
      ['dirección con forma de dominio', { direccion: 'pago-seguro.com' }],
      ['dirección con forma de teléfono', { direccion: 'Llame 0981 123 456' }],
      ['dirección con un número de 5 o más dígitos', { direccion: 'Av. Lopez 12345' }],
      ['dirección de 121 caracteres', { direccion: 'a'.repeat(121) }],
    ])('rechaza %s', (_n, contacto) => {
      expect(Plataforma.safeParse(plataforma({ contacto })).success).toBe(false);
    });
  });

  describe('prompt', () => {
    const config = resolverConfiguracion(cargarConfiguracionDesdeJson(JSON_KUAA), null);
    it('incluye las dos líneas solo si existen', () => {
      const con = armarPromptKuaa(config, entrada({ plataforma: conCampos() }), [], AHORA);
      expect(con).toContain(`- Dirección de Interseguros: «${DIRECCION}».`);
      expect(con).toContain(`- Sitio web de Interseguros: ${DOMINIO}.`);
      const sin = armarPromptKuaa(config, entrada({ plataforma: plataforma() }), [], AHORA);
      expect(sin).not.toContain('Dirección de Interseguros');
      expect(sin).not.toContain('Sitio web de Interseguros');
    });
    it('la regla conserva la prohibición de enlaces con la excepción explícita del sitio web', () => {
      const regla = reglasKuaa(true)[0] as string;
      expect(regla).toContain('no escriba enlaces, con una sola excepción');
      expect(regla).toContain('sin https:// ni ruta');
      expect(reglasKuaa(false)).toEqual(REGLAS_KUAA);
    });
  });

  describe('detector', () => {
    it('permitidosDe lleva el dominio y la dirección normalizada; sin los campos, listas vacías', () => {
      expect(perm.dominios).toEqual([DOMINIO]);
      expect(perm.direcciones).toEqual(['av. mariscal lopez 1234 esq. peru']);
      expect(permSin.dominios).toEqual([]);
      expect(permSin.direcciones).toEqual([]);
    });
    it('la dirección exacta y el dominio suelto pasan', () => {
      expect(patronEnlaceOPrecio(`Estamos en ${DIRECCION}.`, perm)).toBeNull();
      expect(patronEnlaceOPrecio('Estamos en AV. MARISCAL LÓPEZ 1234 ESQ. PERÚ, de lunes a viernes.', perm)).toBeNull();
      expect(patronEnlaceOPrecio(`Puede ver más en ${DOMINIO}.`, perm)).toBeNull();
      expect(patronEnlaceOPrecio(`Visite ${DOMINIO}, o escriba al WhatsApp.`, perm)).toBeNull();
      expect(patronEnlaceOPrecio(`${DIRECCION}. Web: ${DOMINIO}`, perm)).toBeNull();
    });
    it.each([
      ['dominio distinto', 'Visite interseguros.com.py'],
      ['subdominio extra', 'Visite www.interseguros360.com'],
      ['subdominio sin www', 'Visite app.interseguros360.com'],
      ['prefijo pegado', 'Visite xinterseguros360.com'],
      ['dominio más largo', 'Visite interseguros360.com.evil.com'],
      ['con https', 'Visite https://interseguros360.com'],
      ['con ruta', 'Visite interseguros360.com/ruta?x'],
      ['con puerto', 'Visite interseguros360.com:8080'],
      ['en un correo ajeno', 'Escriba a ventas@interseguros360.com'],
      ['frase completa de la dirección con otro número (una parte suelta no se bloquea, como antes)', 'Estamos en Av. Mariscal Lopez 1235 esq. Peru'],
      ['frase completa de la dirección con un número más largo', 'Estamos en Av. Mariscal Lopez 12345 esq. Peru'],
      ['letra o con tilde pegada antes (í)', 'Visite ínterseguros360.com'],
      ['letra ø pegada antes', 'Visite øinterseguros360.com'],
      ['letra ł pegada antes', 'Visite łinterseguros360.com'],
      ['letra ß pegada antes', 'Visite ßinterseguros360.com'],
      ['letra ø pegada después', 'Visite interseguros360.comø'],
      ['rótulo con letra ø después', 'Visite interseguros360.com.øx'],
      ['parámetro con &', 'Visite interseguros360.com&x=1'],
      ['enlace de markdown a otro destino', 'Visite [interseguros360.com](evil.tk)'],
      ['punto ideográfico y otro dominio', 'Visite interseguros360.com。ru'],
      ['punto de ancho completo y otro dominio', 'Visite interseguros360.com．evil.com'],
      ['correo de otro alfabeto', 'Escriba a ventas@ínterseguros360.com'],
    ])('sigue bloqueado: %s', (_n, texto) => {
      expect(patronEnlaceOPrecio(texto, perm)).not.toBeNull();
    });
    it('una ofuscación («punto com») no gana nada con los permitidos: el resultado es el de hoy', () => {
      const texto = 'Visite interseguros360 punto com';
      expect(patronEnlaceOPrecio(texto, perm)).toBe(patronEnlaceOPrecio(texto));
      expect(patronEnlaceOPrecio('Visite interseguros360[.]com', perm)).not.toBeNull();
      expect(patronEnlaceOPrecio('Visite interseguros360(.)com', perm)).not.toBeNull();
      expect(patronEnlaceOPrecio('Visite interseguros360 [dot] com', perm)).not.toBeNull();
    });
    it('pasan el dominio entre signos de pregunta o seguido de dos puntos (sin falso positivo)', () => {
      expect(patronEnlaceOPrecio('¿Conoce interseguros360.com?', perm)).toBeNull();
      expect(patronEnlaceOPrecio('Web: interseguros360.com: lunes a viernes', perm)).toBeNull();
      expect(patronEnlaceOPrecio('(interseguros360.com)', perm)).toBeNull();
      expect(patronEnlaceOPrecio('Es «interseguros360.com».', perm)).toBeNull();
    });
    it('el correo permitido sigue pasando entre puntuación', () => {
      expect(patronEnlaceOPrecio('Escriba a derechos@ejemplo.com.py.', permSin)).toBeNull();
      expect(patronEnlaceOPrecio('(derechos@ejemplo.com.py)', permSin)).toBeNull();
      expect(patronEnlaceOPrecio('Escriba a derechos@ejemplo.com.pyø', permSin)).not.toBeNull();
    });
    it('un invisible (U+200B, U+00AD) dentro del dominio pasa: es inocuo y UTS46 lo ignora', () => {
      expect(patronEnlaceOPrecio('Visite interseguros\u200b360.com', perm)).toBeNull();
      expect(patronEnlaceOPrecio('Visite interseguros\u00ad360.com', perm)).toBeNull();
    });
    it.each([
      ['«і» cirílica al inicio', 'Visite іnterseguros360.com'],
      ['«ѕ» cirílica dentro', 'Visite interѕeguros360.com'],
      ['«і» cirílica y «о» cirílica en el TLD', 'Visite іnterseguros360.соm'],
      ['marca combinante U+0332 dentro', 'Visite interse\u0332guros360.com'],
      ['marca combinante U+0332 delante del dominio', 'Visite \u0332interseguros360.com'],
      ['marca combinante U+0332 al final', 'Visite interseguros360.com\u0332'],
      ['«?» seguido de consulta', 'Visite interseguros360.com?x'],
      ['«?r=» seguido de destino', 'Visite interseguros360.com?r=evil.tk'],
      ['«!» seguido de texto pegado', 'Visite interseguros360.com!x'],
      ['enlace de Markdown con el dominio como texto', 'Visite [interseguros360.com](evil.tk)'],
      ['dominio más largo entre asteriscos', 'Visite **interseguros360.com.evil.com**'],
      ['ruta entre comillas invertidas', 'Visite `interseguros360.com/x`'],
      ['guion pegado antes (otro dominio)', 'Visite evil-interseguros360.com'],
      ['guion bajo pegado antes', 'Visite evil_interseguros360.com'],
      ['adorno de Markdown y texto pegado después', 'Visite **interseguros360.com**evil'],
    ])('homóglifos, marcas y límites bloqueados: %s', (_n, texto) => {
      expect(patronEnlaceOPrecio(texto, perm)).not.toBeNull();
    });
    it.each([
      ['entre asteriscos', 'Visite **interseguros360.com** hoy'],
      ['entre guiones bajos', 'Visite _interseguros360.com_ hoy'],
      ['entre comillas invertidas', 'Visite `interseguros360.com` hoy'],
      ['tras «:» sin espacio', 'Web:interseguros360.com'],
      ['tras raya larga', 'Web —interseguros360.com'],
      ['tras guion con espacio', 'Web - interseguros360.com'],
      ['seguido de puntos suspensivos', 'Visite interseguros360.com...'],
      ['seguido de «…»', 'Visite interseguros360.com… y más'],
      ['seguido de «..»', 'Visite interseguros360.com.. y más'],
      ['entre signos de pregunta', '¿Conoce interseguros360.com?'],
      ['con negrita y punto final', 'Visite **interseguros360.com**.'],
    ])('pasa el dominio %s', (_n, texto) => {
      expect(patronEnlaceOPrecio(texto, perm)).toBeNull();
    });
    it.each([
      ['entre asteriscos', '**derechos@ejemplo.com.py**'],
      ['entre comillas invertidas', '`derechos@ejemplo.com.py`'],
      ['tras «:» sin espacio', 'Correo:derechos@ejemplo.com.py'],
      ['con guiones bajos', '_derechos@ejemplo.com.py_'],
      ['con puntos suspensivos', 'Escriba a derechos@ejemplo.com.py...'],
    ])('pasa el correo permitido %s', (_n, texto) => {
      expect(patronEnlaceOPrecio(texto, permSin)).toBeNull();
    });
    it('el correo permitido con homóglifo, tilde o marca combinante se bloquea', () => {
      for (const t of ['dеrechos@ejemplo.com.py', 'derechos@éjemplo.com.py', 'derechos@e\u0332jemplo.com.py'])
        expect(patronEnlaceOPrecio(`Escriba a ${t}`, permSin)).not.toBeNull();
    });
    it('un punto ideográfico es un punto: «evil。com» dispara `dominio` sin permitidos', () => {
      expect(patronEnlaceOPrecio('evil。com')).toBe('dominio');
      expect(patronEnlaceOPrecio('evil．com')).toBe('dominio');
    });
    it.each([
      ['evil.coΜ', 'dominio'],
      ['evil.pΥ', 'dominio'],
      ['evil.ΝET', 'dominio'],
      ['ΗTTPS://evil.tk', 'https'],
      ['5 ΜIL guaraníes', 'mil_millon'],
      ['cinco ΜILLONES', 'numero_en_palabras'],
      ['ΝUEVE mil', 'numero_en_palabras'],
      ['pΥg 5', 'moneda_antes'],
      ['㏁', null],
      ['ϒ', null],
    ])('sin permitidos «%s» da lo mismo que el detector de main: %s (mayúsculas griegas)', (texto, esperado) => {
      expect(patronEnlaceOPrecio(texto)).toBe(esperado);
    });
    it('una dirección que termina en dígito no deja pasar un importe pegado; una que no, no da falso positivo', () => {
      const DIR_NUM = 'Calle Peru 1234';
      const p = permitidosDe(Plataforma.parse(plataforma({ contacto: { direccion: DIR_NUM } }))) as Permitidos;
      expect(patronEnlaceOPrecio(`Estamos en ${DIR_NUM}.`, p)).toBeNull();
      for (const sufijo of ['mil', 'millones de guaranies', '%']) expect(patronEnlaceOPrecio(`Estamos en ${DIR_NUM} ${sufijo}`, p)).not.toBeNull();
      expect(patronEnlaceOPrecio(`Estamos en ${DIRECCION} mil gracias`, perm)).toBeNull();
    });
    it.each([
      ['enlace con destino sin protocolo', '[x](evil.tk)'],
      ['dominio permitido como texto y destino relativo al protocolo', '[interseguros360.com](//evil.tk)'],
      ['lo mismo con espacios', '[ interseguros360.com ](//evil.tk)'],
      ['con espacio entre corchete y paréntesis', '[x] (evil.tk)'],
    ])('bloquea el enlace de Markdown: %s', (_n, texto) => {
      expect(patronEnlaceOPrecio(texto, perm)).not.toBeNull();
    });
    it.each(['El plan (el básico) cubre lo indicado.', '(ver arriba)', 'Hay tres opciones (A, B y C).'])('un texto normal con paréntesis no dispara: %s', (texto) => {
      expect(patronEnlaceOPrecio(texto, perm)).toBeNull();
    });
    it('la dirección permitida no se confunde con un importe: «…Peru mil gracias» no dispara', () => {
      expect(patronEnlaceOPrecio(`Estamos en ${DIRECCION} mil gracias`, perm)).toBeNull();
    });
    it('un «¶» del modelo no dispara nada sin permitidos ni con ellos, y U+E000 tampoco', () => {
      expect(patronEnlaceOPrecio('texto con ¶ pilcrow')).toBeNull();
      expect(patronEnlaceOPrecio('texto con ¶ pilcrow', perm)).toBeNull();
      expect(patronEnlaceOPrecio('texto con \uE000 privado', perm)).toBeNull();
    });
    it('el detector con 4000 caracteres tarda menos de 500 ms', () => {
      for (const t of ['a'.repeat(4000), '1'.repeat(4000), 'interseguros360.com '.repeat(200), 'a.'.repeat(2000)]) {
        const inicio = performance.now();
        patronEnlaceOPrecio(t, perm);
        expect(performance.now() - inicio).toBeLessThan(500);
      }
    });
    it('el resto sigue bloqueado con los campos presentes', () => {
      expect(patronEnlaceOPrecio('Visite interseguros360.com y también https://otro.com', perm)).not.toBeNull();
      expect(patronEnlaceOPrecio('Cuesta 450.000 Gs', perm)).not.toBeNull();
    });
    it('sin los campos, el dominio se bloquea como hoy y la dirección no cambia nada', () => {
      expect(patronEnlaceOPrecio(`Visite ${DOMINIO}`, permSin)).not.toBeNull();
      expect(patronEnlaceOPrecio(`Visite ${DOMINIO}`)).not.toBeNull();
      expect(patronEnlaceOPrecio(`Estamos en ${DIRECCION}`, permSin)).toBeNull();
      expect(patronEnlaceOPrecio('Cuesta 390.000 Gs', permSin)).toBeNull();
    });
    it('no se permite el dominio si solo se configuró la dirección, ni al revés', () => {
      const soloDir = permitidosDe(Plataforma.parse(plataforma({ contacto: { direccion: DIRECCION } }))) as Permitidos;
      expect(patronEnlaceOPrecio(`Visite ${DOMINIO}`, soloDir)).not.toBeNull();
      const soloWeb = permitidosDe(Plataforma.parse(plataforma({ contacto: { sitio_web: DOMINIO } }))) as Permitidos;
      expect(patronEnlaceOPrecio(`Visite ${DOMINIO}`, soloWeb)).toBeNull();
    });
    it('entradas largas no provocan tiempo cuadrático', () => {
      const largos = [
        'interseguros360.com'.repeat(2630),
        `${DIRECCION} `.repeat(1500),
        'Av. Mariscal Lopez 1 '.repeat(2400),
        ' '.repeat(50000),
        '.'.repeat(50000),
        `${'Av. Mariscal Lopez '.repeat(2600)}1234`,
      ];
      for (const t of largos) {
        const inicio = performance.now();
        patronEnlaceOPrecio(t, perm);
        expect(performance.now() - inicio).toBeLessThan(500);
      }
    });
  });
});
