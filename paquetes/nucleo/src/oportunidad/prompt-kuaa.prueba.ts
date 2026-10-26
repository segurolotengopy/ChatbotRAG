import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cargarConfiguracionDesdeJson } from '../configuracion/cargar.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { ESTADOS_OPERATIVOS_DESCONOCIDOS, EntradaKuaa, ETAPAS_VENTA, RESUMEN_DESCONOCIDO } from './esquemas.js';
import * as F from './frases-kuaa.js';
import { armarPromptKuaa } from './prompt-kuaa.js';

const RUTA = fileURLToPath(new URL('../../../../configuraciones/kuaa.json', import.meta.url));
const config = resolverConfiguracion(cargarConfiguracionDesdeJson(readFileSync(RUTA, 'utf8')), null);
const AHORA = new Date('2026-10-26T14:00:00Z');

const entrada = (cambios: Record<string, unknown> = {}) =>
  EntradaKuaa.parse({
    oportunidad_id: 'Centinela_ABC123',
    etapa_actual: 'E04',
    estados: { ...ESTADOS_OPERATIVOS_DESCONOCIDOS },
    permiso_seguimiento: { vigente: false, canal: 'ninguno' },
    tarifa_version: 'zz-centinela-9',
    pagina: 'pantalla-centinela',
    resumen: { ...RESUMEN_DESCONOCIDO },
    mensaje: 'MENSAJE-CENTINELA',
    ...cambios,
  });

describe('tablas de frases de Kuaa: cubren todo su enumerado', () => {
  // Oráculos escritos en la prueba, no importados del código.
  const casos: [string, Record<string, string>, string[]][] = [
    ['etapa', F.FRASE_ETAPA_KUAA, ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12']],
    ['solicitud', F.FRASE_ESTADO_SOLICITUD, ['desconocido', 'no_iniciada', 'en_curso', 'completada']],
    ['pago', F.FRASE_ESTADO_PAGO, ['desconocido', 'no_aplica', 'pendiente', 'acreditado', 'rechazado']],
    ['aceptacion', F.FRASE_ESTADO_ACEPTACION, ['desconocido', 'pendiente', 'aceptada', 'rechazada']],
    ['poliza', F.FRASE_ESTADO_POLIZA, ['desconocido', 'no_emitida', 'emitida']],
    ['documentos', F.FRASE_ESTADO_DOCUMENTOS, ['desconocido', 'pendientes', 'recibidos', 'verificados']],
    ['atencion', F.FRASE_ESTADO_ATENCION_HUMANA, ['desconocido', 'no_requerida', 'solicitada', 'en_curso', 'resuelta']],
    ['permiso', F.FRASE_PERMISO_SEGUIMIENTO, ['vigente_whatsapp', 'vigente_correo', 'no_vigente']],
    ['necesidad', F.FRASE_NECESIDAD, ['respaldo_economico', 'atencion_medica', 'otra_proteccion', 'desconocido']],
    ['producto', F.FRASE_PRODUCTO, ['VIDA_ONCOLOGICO', 'VIDA', 'ACCIDENTES_PERSONALES', 'RESPONSABILIDAD_CIVIL', 'desconocido']],
    ['plan', F.FRASE_PLAN, ['CONFIO', 'CONFIO_PLUS', 'CONFIO_TOTAL', 'ninguno']],
    ['objecion', F.FRASE_OBJECION_ESTADO, ['ninguna', 'detectada', 'en_aclaracion', 'respondida', 'resuelta_explicita', 'pendiente_humana', 'cerrada_sin_venta']],
  ];
  it.each(casos)('%s', (_n, tabla, claves) => {
    expect(Object.keys(tabla).sort()).toEqual([...claves].sort());
    for (const frase of Object.values(tabla)) {
      expect(frase.length).toBeGreaterThan(10);
      expect(frase).not.toContain('{');
    }
  });
  it('reglas, jerarquía y formato no llevan llaves ni enlaces ni precios', () => {
    for (const t of [...F.JERARQUIA_KUAA, ...F.REGLAS_KUAA, F.FORMATO_SALIDA_KUAA]) {
      expect(t).not.toContain('{');
      expect(t).not.toMatch(/https?:\/\/|www\.|Gs\.|₲|\d\.\d{3}/);
    }
    for (const e of ETAPAS_VENTA) expect(F.FORMATO_SALIDA_KUAA).toContain(e);
    expect(F.FORMATO_SALIDA_KUAA).toContain('O01 a O32');
  });
});

describe('armarPromptKuaa', () => {
  it('trata en vos, no dice «sin voseo» y no usa las frases de usted ni de tú', () => {
    const p = armarPromptKuaa(config, entrada(), [], AHORA);
    expect(p).toContain('VOS');
    expect(p).not.toContain('sin voseo');
    expect(p).not.toContain('de USTED en todo momento');
    expect(p).not.toContain('de TÚ en todo momento');
  });

  it('no interpola oportunidad_id, tarifa_version, pagina ni el mensaje', () => {
    const p = armarPromptKuaa(config, entrada(), [], AHORA);
    for (const c of ['Centinela_ABC123', 'zz-centinela-9', 'pantalla-centinela', 'MENSAJE-CENTINELA']) expect(p).not.toContain(c);
  });

  it('cada enumerado selecciona exactamente su frase literal', () => {
    const p = armarPromptKuaa(
      config,
      entrada({
        etapa_actual: 'E09',
        estados: { solicitud: 'completada', pago: 'acreditado', aceptacion: 'aceptada', poliza: 'no_emitida', documentos: 'recibidos', atencion_humana: 'solicitada' },
        permiso_seguimiento: { vigente: true, canal: 'whatsapp' },
        resumen: { necesidad: 'atencion_medica', producto: 'VIDA_ONCOLOGICO', plan: 'CONFIO_PLUS', objecion_codigo: 'O07', objecion_estado: 'en_aclaracion' },
      }),
      [],
      AHORA,
    );
    for (const f of [
      'Etapa comercial actual: pago acreditado según el sistema. No prometa la emisión de la póliza.',
      'Estado de la solicitud: completada.',
      'Estado del pago: acreditado según el sistema.',
      'Estado de la aceptación: aceptada según el sistema.',
      'Estado de la póliza: no emitida. No la dé por emitida.',
      'Estado de los documentos: recibidos, sin verificar.',
      'Atención humana: ya solicitada. No la prometa de nuevo.',
      'Permiso de seguimiento: vigente por WhatsApp. Solo puede proponerlo; no lo ejecuta.',
      'Necesidad declarada: atención médica.',
      'Producto de interés: vida con cobertura oncológica.',
      'Plan de interés: el plan intermedio de la familia de planes.',
      'Objeción: en aclaración con la persona.',
    ])
      expect(p).toContain(f);
    expect(p).not.toContain('O07');
    expect(p).not.toContain('Estado del pago: pendiente.');
  });

  it('permiso vigente con canal ninguno cuenta como no vigente', () => {
    const p = armarPromptKuaa(config, entrada({ permiso_seguimiento: { vigente: true, canal: 'ninguno' } }), [], AHORA);
    expect(p).toContain('Permiso de seguimiento: no vigente.');
  });

  it('ordena: reglas, jerarquía, fecha, datos y al final contexto y formato', () => {
    const p = armarPromptKuaa(config, entrada(), [], AHORA);
    const orden = ['\nREGLAS\n', 'JERARQUÍA DE FUENTES', 'REGLAS DE KUAA', 'FECHA Y HORA ACTUAL', 'INICIO DE DATOS', 'CONTEXTO DE LA OPORTUNIDAD', 'FORMATO DE SALIDA'].map((m) => p.indexOf(m));
    expect(orden.every((i) => i >= 0)).toBe(true);
    expect([...orden].sort((a, b) => a - b)).toEqual(orden);
  });

  it('sin fragmentos y con respaldo exigido incluye la sección de sin respaldo', () => {
    expect(armarPromptKuaa(config, entrada(), [], AHORA)).toContain('SIN RESPALDO DOCUMENTAL');
  });
});
