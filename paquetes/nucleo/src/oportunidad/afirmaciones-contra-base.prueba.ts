/**
 * Pruebas del verificador de afirmaciones contrarias a la base (hallazgos de Rodrigo, 8-nov-2026).
 * Las respuestas de Kuaa del informe van literales (precedente TCV014/TCV062 de `plataforma.prueba.ts`); los textos de la
 * BASE van solo parafraseados: el texto real de la base no entra al repositorio. La comprobación contra la base literal
 * se hace fuera del repo.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { cargarConfiguracionDesdeJson } from '../configuracion/cargar.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { IndiceEnMemoria } from '../conocimiento/indice-memoria.js';
import { RegistroHerramientas } from '../herramientas/registro.js';
import { MemoriaEnProceso } from '../memoria/memoria-en-proceso.js';
import type { PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { AgenteKuaa } from './agente-kuaa.js';
import { afirmaContraBase, CORRECCION_POR_MOTIVO, MOTIVOS_CONTRA_BASE, motivoContraBaseEnOracion, partirOraciones, quitarAfirmacionesContraBase } from './afirmaciones-contra-base.js';
import { ESTADOS_OPERATIVOS_DESCONOCIDOS, EntradaKuaa, PropuestaSalida, RESUMEN_DESCONOCIDO } from './esquemas.js';
import { fraseDerivacionKuaa, patronEnlaceOPrecio, permitidosDe, textoSinRespaldo } from './salida-kuaa.js';

const RUTA = fileURLToPath(new URL('../../../../configuraciones/kuaa.json', import.meta.url));
const JSON_KUAA = readFileSync(RUTA, 'utf8');

// Respuestas reales de Kuaa del informe de Rodrigo (anexo A).
const R45 = 'La carencia es un período previsto en el contrato durante el cual una cobertura todavía no responde. En el Seguro de Vida Oncológico, la documentación indica 90 días para la indemnización por cáncer. Para las demás coberturas, como fallecimiento, renta hospitalaria y gastos médicos por accidente, no hay carencia.';
const R45_BUENO = 'La carencia es un período previsto en el contrato durante el cual una cobertura todavía no responde. En el Seguro de Vida Oncológico, la documentación indica 90 días para la indemnización por cáncer.';
const R64 = 'La documentación del recorrido contempla el pago con tarjeta de débito o crédito propios.';
const R75 = 'No, solo podés contratar una póliza de VIVE a tu nombre.';
const R76 = 'No es posible contratar dos pólizas de VIVE a tu nombre. Por lo tanto, no se sumarían los montos.';
const R79 = 'No es posible contratar dos pólizas de VIVE a tu nombre. Te sugiero que revises los planes VIVE, VIVE+ y VIVE TOTAL para ver cuál se ajusta mejor a tus necesidades de cobertura.';
const R94 = 'Sí, para el reembolso de gastos médicos, las boletas o facturas deben ser originales y estar a tu nombre. También vas a necesitar el programa médico que prescriba las prestaciones, exámenes o insumos que generaron esos gastos.';
const R94_BUENO = 'También vas a necesitar el programa médico que prescriba las prestaciones, exámenes o insumos que generaron esos gastos.';
const R96 = 'La compañía tiene un plazo de 30 días corridos para revisar tu reclamo y, si corresponde, realizar el pago. Este plazo empieza a correr desde que presentás toda la documentación completa.';
const R106 = 'Tu contrato va a estar a nombre de Interseguros S.A., que es la compañía aseguradora.';
const R108 = 'Sí, Interseguros puede aceptar o rechazar tu solicitud de seguro.';
const R143 = 'Sí, la renta hospitalaria por accidente tiene una carencia de 1 día.';
const R144 = 'Sí, los gastos médicos por accidente tienen la misma carencia de 1 día que la renta hospitalaria por accidente.';
const R168 = 'Las exclusiones pueden variar según la cobertura. Por ejemplo, para la cobertura de cáncer, se excluyen los diagnósticos que se inicien o detecten durante el período de carencia. Para accidentes, se excluyen los que no ameritaron hospitalización.';
const R168_BUENO = 'Las exclusiones pueden variar según la cobertura. Por ejemplo, para la cobertura de cáncer, se excluyen los diagnósticos que se inicien o detecten durante el período de carencia.';
const R192 = 'El sistema te permite iniciar una solicitud. Si ya tenés una póliza de VIVE, te recomiendo consultar con Interseguros para saber si podés contratar otra o si es necesario que un asesor revise tu situación. Podés contactarlos al +595 991 478 468.';
const R200 = 'Sí, podés pagar el seguro de un familiar, siempre y cuando él sea quien complete y firme su propia solicitud.';
const R36 = 'No puedo indicarte medicamentos ni hacer un diagnóstico. Consultá a un profesional de salud; si hay peligro inmediato, buscá atención de emergencia local. Puedo orientarte sobre información de tu seguro.';

describe('afirmaContraBase: respuestas reales del informe que deben detectarse', () => {
  it.each([
    ['45', R45, 'carencia_accidente'],
    ['75', R75, 'multiples_polizas'],
    ['76', R76, 'multiples_polizas'],
    ['79', R79, 'multiples_polizas'],
    ['94', R94, 'titular_facturas'],
    ['96', R96, 'plazo_siniestro'],
    ['106', R106, 'rol_corredor'],
    ['108', R108, 'rol_corredor'],
    ['168', R168, 'exclusion_trasladada'],
    ['200', R200, 'pago_terceros'],
  ] as const)('la respuesta %s', (_id, texto, motivo) => {
    expect(afirmaContraBase(texto)).toBe(motivo);
  });
  it('la segunda oración de la 76 se detecta sola (suma de montos)', () => {
    expect(motivoContraBaseEnOracion('Por lo tanto, no se sumarían los montos.')).toBe('multiples_polizas');
  });
});

describe('afirmaContraBase: variantes de redacción y de trato', () => {
  it.each([
    ['Solo puede contratar una póliza a su nombre.', 'multiples_polizas'],
    ['Interseguros es la aseguradora.', 'rol_corredor'],
    ['La aseguradora es Interseguros S.A.', 'rol_corredor'],
    ['Interseguros S.A. es la compañía aseguradora.', 'rol_corredor'],
    ['Interseguros acepta o rechaza tu solicitud.', 'rol_corredor'],
    ['Tu contrato queda a nombre de Interseguros.', 'rol_corredor'],
    ['La renta hospitalaria no tiene carencia.', 'carencia_accidente'],
    ['Los gastos médicos por accidente no tienen carencia.', 'carencia_accidente'],
    ['La renta y el fallecimiento no tienen carencia.', 'carencia_accidente'],
    ['Sin carencia para el fallecimiento y la renta.', 'carencia_accidente'],
    ['El cáncer no tiene carencia.', 'carencia_accidente'],
    ['Carencia de 0 días para la renta.', 'carencia_accidente'],
    ['Las facturas deben estar a su nombre.', 'titular_facturas'],
    ['Los comprobantes tienen que ir a nombre del asegurado.', 'titular_facturas'],
    ['No hace falta que las facturas estén a tu nombre.', 'titular_facturas'],
    ['La aseguradora paga en 15 días hábiles.', 'plazo_siniestro'],
    ['El reembolso se paga dentro de 30 días.', 'plazo_siniestro'],
    ['Un familiar puede pagarlo.', 'pago_terceros'],
    ['Podés pagar con la tarjeta de tu pareja.', 'pago_terceros'],
    ['No podés pagar el seguro de otra persona.', 'pago_terceros'],
    ['No es posible tener más de una póliza.', 'multiples_polizas'],
    ['Es una póliza por persona.', 'multiples_polizas'],
    ['Se suman los montos.', 'multiples_polizas'],
    ['Para todas las coberturas se excluyen los accidentes que no ameritaron hospitalización.', 'exclusion_trasladada'],
    ['En la renta y en gastos médicos se excluyen los accidentes que no ameritaron hospitalización.', 'exclusion_trasladada'],
  ] as const)('«%s»', (texto, motivo) => {
    expect(afirmaContraBase(texto)).toBe(motivo);
  });
  it('variante NO cubierta (verbo detrás del sustantivo): «Los montos se suman» no se detecta', () => {
    // Límite declarado: es una lista, no una demostración.
    expect(afirmaContraBase('Los montos se suman.')).toBeNull();
  });
});

describe('afirmaContraBase: lo que debe pasar intacto', () => {
  it.each([
    ['143', R143],
    ['144', R144],
    ['64', R64],
    ['192', R192],
    ['36 (texto aprobado, inútil pero no falso)', R36],
    ['45 sin la oración falsa', R45_BUENO],
    ['94 sin la oración falsa', R94_BUENO],
  ])('la respuesta %s', (_id, texto) => {
    expect(afirmaContraBase(texto)).toBeNull();
  });
  it.each([
    'Según la documentación, Alianza es la aseguradora del producto e Interseguros actúa como corredor.',
    'Interseguros no es la aseguradora: es el corredor.',
    'Tu contrato no va a nombre de Interseguros.',
    'Interseguros puede ayudarte con el seguimiento.',
    'Para cáncer hay 90 días de carencia, para la renta y los gastos médicos por accidente 1 día, y sin carencia para el fallecimiento.',
    'El fallecimiento no tiene carencia.',
    'El fallecimiento por accidente no tiene carencia.',
    'No hay carencia para el fallecimiento; para cáncer son 90 días.',
    'Hay un aviso general de 3 días y uno de 30 días para gastos médicos desde el hecho.',
    'Existe un plazo de gracia de 30 días para pagar la prima.',
    'No puedo prometer que te paguen en 15 días; la aseguradora evalúa cada caso.',
    'El plazo para el envío de la póliza es de 24 horas desde la acreditación del pago.',
    'Para cáncer, la indemnización se paga después de 90 días de carencia.',
    'No puedo confirmar si las facturas deben estar a nombre de Alianza; consultá a Interseguros antes de pedir cambios.',
    'Guardá los comprobantes y consultá a Interseguros cómo presentarlos.',
    'En la renta hospitalaria se excluyen los accidentes que no ameritaron hospitalización; no se traslada a gastos médicos.',
    'La atención ambulatoria está excluida de la renta.',
    'Te recomiendo consultar con Interseguros para saber si podés contratar dos pólizas.',
    'No tengo información sobre pagar con la tarjeta de tu pareja; consultá a Interseguros.',
    'La documentación contempla el pago con tarjeta de débito o crédito propios.',
    'La suma asegurada es el límite de cada cobertura.',
    'El seguro cubre solo a la persona titular.',
  ])('«%s»', (texto) => {
    expect(afirmaContraBase(texto)).toBeNull();
  });
});

describe('partirOraciones y quitarAfirmacionesContraBase', () => {
  it('no parte en «S.A.» ni en «Gs.» seguido de cifra, pero sí tras un punto normal', () => {
    expect(partirOraciones('Interseguros S.A. es la compañía aseguradora. Hola.')).toHaveLength(2);
    expect(partirOraciones('El premio es Gs. 390.000 por año.')).toHaveLength(1);
  });
  it('la 45 queda con sus dos primeras oraciones y el motivo', () => {
    expect(quitarAfirmacionesContraBase(R45)).toEqual({ texto: R45_BUENO, motivos: ['carencia_accidente'] });
  });
  it('la 96 se retira entera: la oración siguiente («Este plazo…») cae por anáfora', () => {
    expect(quitarAfirmacionesContraBase(R96)).toEqual({ texto: '', motivos: ['plazo_siniestro'] });
  });
  it('la anáfora arrastra solo un nivel', () => {
    const r = quitarAfirmacionesContraBase('La aseguradora paga en 15 días hábiles. Este dato extra aplica siempre. Otra oración que sí queda.');
    expect(r.texto).toBe('Otra oración que sí queda.');
  });
  it('la 168 conserva las dos primeras oraciones', () => {
    expect(quitarAfirmacionesContraBase(R168).texto).toBe(R168_BUENO);
  });
  it('un texto limpio no cambia', () => {
    expect(quitarAfirmacionesContraBase(R192)).toEqual({ texto: R192, motivos: [] });
  });
  it('un texto de 4000 caracteres hostil se procesa rápido (sin retroceso catastrófico)', () => {
    const hostil = 'interseguros s.a. no hay carencia renta '.repeat(100);
    const t0 = performance.now();
    afirmaContraBase(hostil);
    quitarAfirmacionesContraBase(hostil);
    afirmaContraBase('a'.repeat(4000));
    afirmaContraBase(' '.repeat(4000));
    expect(performance.now() - t0).toBeLessThan(200);
  });
});

describe('tabla de correcciones', () => {
  it('hay una frase fija por motivo, sin cifras ni nombres de la base', () => {
    for (const m of MOTIVOS_CONTRA_BASE) {
      expect(CORRECCION_POR_MOTIVO[m].length).toBeGreaterThan(40);
      expect(CORRECCION_POR_MOTIVO[m]).not.toMatch(/\d/);
      expect(CORRECCION_POR_MOTIVO[m]).not.toMatch(/alianza|QA\d|C04/i);
    }
  });
});

// ---- Agente ----

class ProveedorSecuencia implements ProveedorLLM {
  readonly nombre = 'secuencia';
  readonly peticiones: PeticionLLM[] = [];
  private i = 0;
  constructor(private readonly respuestas: (string | Partial<RespuestaLLM> | Error)[]) {}
  async generar(p: PeticionLLM): Promise<RespuestaLLM> {
    this.peticiones.push(p);
    const r = this.respuestas[Math.min(this.i++, this.respuestas.length - 1)]!;
    if (r instanceof Error) throw r;
    const base: RespuestaLLM = { texto: '', llamadasHerramienta: [], motivoFin: 'fin', uso: { tokensEntrada: 10, tokensSalida: 5 } };
    return typeof r === 'string' ? { ...base, texto: r } : { ...base, ...r };
  }
}
const salidaJson = (texto: string, cambios: Record<string, unknown> = {}) => JSON.stringify({ texto, etapa_propuesta: 'E04', objecion: null, botones: [], propuestas: [], ...cambios });

const plan = {
  producto: 'VIDA_ONCOLOGICO', plan: 'CONFIO', nombre: 'Confio Basico', premio_anual_gs: 390000, capital_fallecimiento_gs: 20000000,
  indemnizacion_cancer_gs: 10000000, renta_hospitalaria_dia_gs: 100000, renta_dias_max: 30, gastos_medicos_accidente_gs: 2000000,
};
const plataforma = () => ({
  version: 'v0.4',
  catalogo: [{ producto: 'VIDA_ONCOLOGICO', nombre: 'Vida con cobertura oncológica', estado: 'disponible' }],
  planes: [plan],
  contacto: { whatsapp_e164: '+595991478468', canal: 'WhatsApp SLT', correo_derechos: 'derechos@ejemplo.com.py' },
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
    mensaje: 'proceso pasos sintéticos',
    plataforma: plataforma(),
    ...cambios,
  });

/** `respuestas`: una por llamada al modelo; la última se repite. */
async function armar(...respuestas: (string | Partial<RespuestaLLM> | Error)[]) {
  const config = cargarConfiguracionDesdeJson(JSON_KUAA);
  const indice = new IndiceEnMemoria(null);
  await indice.indexar([{ id: 'f1', coleccion: coleccionDe(config, null), fuenteId: 'doc', fuenteTitulo: 'Documento sintético', fuenteVersion: 'v1', orden: 0, texto: 'El proceso tiene cuatro pasos sintéticos.' }]);
  const proveedor = new ProveedorSecuencia(respuestas);
  const bitacora = new BitacoraEnMemoria();
  const memoria = new MemoriaEnProceso();
  const agente = new AgenteKuaa({ config, proveedor, indice, memoria, herramientas: new RegistroHerramientas(null), bitacora });
  return { agente, proveedor, bitacora, memoria, config };
}
const DERIV_VOS = 'Podés escribir al WhatsApp +595 991 478 468 y una persona del equipo te ayuda.';

describe('fraseDerivacionKuaa', () => {
  it('con plataforma y vos nombra el WhatsApp; sin plataforma usa mensajes.derivacion', () => {
    const config = cargarConfiguracionDesdeJson(JSON_KUAA);
    expect(fraseDerivacionKuaa(config, entrada().plataforma)).toBe(DERIV_VOS);
    expect(fraseDerivacionKuaa(config, undefined)).toBe(config.mensajes.derivacion);
  });
});

describe('agente: corrección de afirmaciones contrarias a la base', () => {
  it('45 (siempre mala): reintenta una vez y luego retira la oración y agrega la derivación', async () => {
    const { agente, proveedor, bitacora } = await armar(salidaJson(R45));
    const { salida, avisos } = await agente.responder(entrada(), 'c');
    expect(salida.texto).toBe(`${R45_BUENO} ${DERIV_VOS}`);
    expect(proveedor.peticiones).toHaveLength(2);
    expect(avisos).toEqual(expect.arrayContaining(['reintento_contra_base:carencia_accidente', 'contra_base:carencia_accidente', 'frase_contra_base_retirada']));
    expect(bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')).toMatchObject({ iteraciones: 2, tokensEntrada: 20, tokensSalida: 10 });
  });
  it('primera mala y segunda limpia: se usa la segunda, con dos llamadas, tokens sumados y el aviso del reintento', async () => {
    const limpia = 'Para cáncer la documentación indica un período de carencia; para el resto consulto el detalle por cobertura.';
    const { agente, proveedor, bitacora } = await armar(salidaJson(R45), salidaJson(limpia));
    const { salida, avisos } = await agente.responder(entrada({ mensaje: 'proceso pasos sintéticos' }), 'c');
    expect(salida.texto).toBe(limpia);
    expect(proveedor.peticiones).toHaveLength(2);
    expect(avisos).toContain('reintento_contra_base:carencia_accidente');
    expect(avisos.some((a) => a.startsWith('contra_base:') || a === 'frase_contra_base_retirada')).toBe(false);
    expect(bitacora.eventos.find((e) => e.tipo === 'mensaje_atendido')).toMatchObject({ iteraciones: 2, tokensEntrada: 20, tokensSalida: 10 });
    // La corrección va en el mensaje de la persona de la segunda petición, y solo ahí; nunca el texto del modelo.
    const ultimo = (i: number) => proveedor.peticiones[i]!.mensajes.at(-1)!.contenido;
    expect(ultimo(0)).toBe('proceso pasos sintéticos');
    expect(ultimo(1)).toContain(CORRECCION_POR_MOTIVO.carencia_accidente);
    expect(ultimo(1)).not.toContain('no hay carencia');
  });
  it('106 (siempre mala): reemplazo total por «sin respaldo» con la derivación, sin botones ni propuestas', async () => {
    const { agente, proveedor, config } = await armar(salidaJson(R106, { botones: ['ver_planes'] }));
    const { salida, avisos } = await agente.responder(entrada(), 'c');
    expect(salida.texto).toBe(textoSinRespaldo(config, entrada().plataforma));
    expect(salida.botones).toEqual([]);
    expect(salida.propuestas).toEqual([]);
    expect(salida.etapa_propuesta).toBe('E04');
    expect(proveedor.peticiones).toHaveLength(2);
    expect(avisos).toContain('respuesta_contra_base_reemplazada');
    expect(avisos).not.toContain('sin_respaldo');
  });
  it('96: reemplazo total (no queda «Este plazo…»)', async () => {
    const { agente } = await armar(salidaJson(R96));
    const { salida, avisos } = await agente.responder(entrada(), 'c');
    expect(salida.texto).not.toContain('Este plazo');
    expect(avisos).toContain('respuesta_contra_base_reemplazada');
  });
  it('94: queda la segunda oración y la derivación', async () => {
    const { agente } = await armar(salidaJson(R94));
    const { salida } = await agente.responder(entrada(), 'c');
    expect(salida.texto).toBe(`${R94_BUENO} ${DERIV_VOS}`);
  });
  it('168: quedan las dos primeras oraciones y la derivación', async () => {
    const { agente } = await armar(salidaJson(R168));
    const { salida } = await agente.responder(entrada(), 'c');
    expect(salida.texto).toBe(`${R168_BUENO} ${DERIV_VOS}`);
  });
  it.each([['192', R192], ['143', R143], ['64', R64]])('%s pasa intacta, con una sola llamada y sin avisos contra_base', async (_id, texto) => {
    const { agente, proveedor } = await armar(salidaJson(texto));
    const { salida, avisos } = await agente.responder(entrada(), 'c');
    expect(salida.texto).toBe(texto);
    expect(proveedor.peticiones).toHaveLength(1);
    expect(avisos.some((a) => a.includes('contra_base'))).toBe(false);
  });
  it('45 sin plataforma: la derivación agregada es mensajes.derivacion', async () => {
    const config = cargarConfiguracionDesdeJson(JSON_KUAA);
    expect(patronEnlaceOPrecio(R45, permitidosDe(undefined))).toBeNull();
    const { agente } = await armar(salidaJson(R45));
    const { salida } = await agente.responder(entrada({ plataforma: undefined }), 'c');
    expect(salida.texto).toBe(`${R45_BUENO} ${config.mensajes.derivacion}`);
  });
  it('con 106 solo sobrevive la propuesta de atención humana', async () => {
    const otra = PropuestaSalida.options.find((p) => p !== 'atencion_humana_solicitada' && p !== 'seguimiento_solicitado')!;
    const { agente } = await armar(salidaJson(R106, { propuestas: ['atencion_humana_solicitada', otra] }));
    const { salida } = await agente.responder(entrada(), 'c');
    expect(salida.propuestas).toEqual(['atencion_humana_solicitada']);
  });
  it('la bitácora no lleva el texto de la persona ni del asistente', async () => {
    for (const [texto, prohibidos] of [[R106, ['Interseguros', 'aseguradora']], [R45, ['período previsto', 'no hay carencia', 'indemnización']]] as const) {
      const { agente, bitacora } = await armar(salidaJson(texto));
      await agente.responder(entrada({ mensaje: 'proceso pasos sintéticos MENSAJE-PERSONA-CENTINELA' }), 'c');
      const volcado = JSON.stringify(bitacora.eventos);
      expect(volcado).not.toContain('CENTINELA');
      for (const p of prohibidos) expect(volcado).not.toContain(p);
    }
  });
  it('la memoria guarda solo el texto final corregido, nunca la afirmación falsa, y el mensaje original de la persona', async () => {
    const { agente, proveedor } = await armar(salidaJson(R45));
    await agente.responder(entrada(), 'c');
    await agente.responder(entrada({ mensaje: 'proceso pasos sintéticos otra vez' }), 'c');
    const historial = proveedor.peticiones[2]!.mensajes;
    expect(historial.some((m) => m.rol === 'asistente' && m.contenido.includes('no hay carencia'))).toBe(false);
    expect(historial.some((m) => m.rol === 'asistente' && m.contenido.includes('90 días'))).toBe(true);
    expect(historial.some((m) => m.contenido.includes('Corrección de su respuesta'))).toBe(false);
  });

  describe('límites del reintento', () => {
    it('reintento omitido por tiempo (más de 3 s desde la llegada): una sola llamada y se aplica el retiro', async () => {
      const ahora = vi.spyOn(performance, 'now');
      let t = 0;
      ahora.mockImplementation(() => (t += 3001));
      try {
        const { agente, proveedor } = await armar(salidaJson(R45));
        const { salida, avisos } = await agente.responder(entrada(), 'c');
        expect(proveedor.peticiones).toHaveLength(1);
        expect(salida.texto).toBe(`${R45_BUENO} ${DERIV_VOS}`);
        expect(avisos.some((a) => a.startsWith('reintento_contra_base'))).toBe(false);
        expect(avisos).toContain('contra_base:carencia_accidente');
      } finally {
        ahora.mockRestore();
      }
    });
    it('formato roto y luego contenido malo: tope de tres llamadas en total, nunca cuatro', async () => {
      const { agente, proveedor } = await armar('{"texto": a}', salidaJson(R45));
      const { avisos } = await agente.responder(entrada(), 'c');
      expect(proveedor.peticiones).toHaveLength(3);
      expect(avisos.filter((a) => a === 'reintento_formato')).toHaveLength(1);
      expect(avisos.filter((a) => a.startsWith('reintento_contra_base'))).toHaveLength(1);
      expect(avisos).toContain('frase_contra_base_retirada');
    });
    it('contenido malo y luego formato roto: un reintento de formato y se cae al error temporal, tope de tres llamadas', async () => {
      const { agente, proveedor, config } = await armar(salidaJson(R45), '{"texto": a}');
      const { salida, avisos } = await agente.responder(entrada(), 'c');
      expect(proveedor.peticiones).toHaveLength(3);
      expect(salida.texto).toBe(config.mensajes.errorTemporal);
      expect(avisos).toContain('salida_invalida');
    });
    it('error del proveedor en el reintento: fallback del error con 2 iteraciones, no un texto de contenido', async () => {
      const { agente, bitacora, config } = await armar(salidaJson(R45), new Error('falla'));
      const { salida, avisos } = await agente.responder(entrada(), 'c');
      expect(salida.texto).toBe(config.mensajes.errorTemporal);
      expect(avisos).toContain('error_modelo');
      expect(bitacora.eventos.find((e) => e.tipo === 'error_modelo')).toMatchObject({ iteraciones: 2, tokensEntrada: 10, tokensSalida: 5 });
    });
    it('sin respaldo documental no se gasta un reintento: el turno termina en «sin respaldo»', async () => {
      const config = cargarConfiguracionDesdeJson(JSON_KUAA);
      const proveedor = new ProveedorSecuencia([salidaJson(R45)]);
      const agente = new AgenteKuaa({ config, proveedor, indice: new IndiceEnMemoria(null), memoria: new MemoriaEnProceso(), herramientas: new RegistroHerramientas(null), bitacora: new BitacoraEnMemoria() });
      const { avisos } = await agente.responder(entrada({ mensaje: '¿Cuánto cubre el plan intermedio?' }), 'c');
      expect(proveedor.peticiones).toHaveLength(1);
      expect(avisos).toContain('sin_respaldo');
    });
  });
});
