import { describe, expect, it } from 'vitest';
import {
  ContextoOportunidad,
  RESUMEN_DESCONOCIDO,
  SalidaOportunidad,
  TIPOS_EVENTO_OPORTUNIDAD,
  filtrarBotonesSalida,
  ESTADOS_OPERATIVOS_DESCONOCIDOS,
  ETAPAS_VENTA,
  EstadoObjecion,
  EtapaVenta,
  NOMBRE_ETAPA,
  PermisoSeguimiento,
  puedeTransicionarEstadoOperativo,
} from './esquemas.js';

const contextoValido = {
  oportunidad_id: 'op-sintetica-1',
  etapa_actual: null,
  estados: { ...ESTADOS_OPERATIVOS_DESCONOCIDOS },
  permiso_seguimiento: { vigente: false, canal: 'ninguno' },
  tarifa_version: null,
  pagina: null,
  resumen: { ...RESUMEN_DESCONOCIDO },
};

describe('etapas y enumerados', () => {
  it('son exactamente E01..E12', () => {
    expect([...ETAPAS_VENTA]).toEqual(
      ['E01', 'E02', 'E03', 'E04', 'E05', 'E06', 'E07', 'E08', 'E09', 'E10', 'E11', 'E12'],
    );
    expect(Object.keys(NOMBRE_ETAPA)).toHaveLength(12);
    expect(NOMBRE_ETAPA.E10).toBe('poliza_emitida');
    expect(EtapaVenta.safeParse('E13').success).toBe(false);
  });
  it('objeciones: lista cerrada', () => {
    expect(EstadoObjecion.options).toEqual([
      'detectada', 'en_aclaracion', 'respondida', 'resuelta_explicita', 'pendiente_humana', 'cerrada_sin_venta',
    ]);
    expect(EstadoObjecion.safeParse('inventada').success).toBe(false);
  });
});

describe('ContextoOportunidad', () => {
  it('acepta el contexto mínimo desconocido', () => {
    expect(ContextoOportunidad.safeParse(contextoValido).success).toBe(true);
  });
  it.each(['salud', 'cedula', 'tarjeta'])('rechaza el campo de datos personales «%s»', (campo) => {
    expect(ContextoOportunidad.safeParse({ ...contextoValido, [campo]: 'x' }).success).toBe(false);
  });
  it('rechaza estados fuera de la lista y campos extra en el permiso', () => {
    expect(
      ContextoOportunidad.safeParse({ ...contextoValido, estados: { ...contextoValido.estados, pago: 'pagado' } }).success,
    ).toBe(false);
    expect(PermisoSeguimiento.safeParse({ vigente: true, canal: 'whatsapp', evidencia_id: null }).success).toBe(false);
    expect(PermisoSeguimiento.safeParse({ vigente: 'si', canal: 'whatsapp', evidencia_id: null }).success).toBe(false);
  });
});

describe('puedeTransicionarEstadoOperativo', () => {
  const base = { ...ESTADOS_OPERATIVOS_DESCONOCIDOS };

  it.each(['E08', 'E09', 'E10'] as const)('la etapa propuesta %s no altera estados operativos', (etapa) => {
    const r = puedeTransicionarEstadoOperativo(base, { etapa_propuesta: etapa });
    expect(r.permitido).toBe(false);
    expect(r.estados).toEqual(base);
  });

  it('un evento sin firma verdadera no cambia nada', () => {
    for (const ev of [{ estado: 'pago', valor: 'acreditado' }, { estado: 'pago', valor: 'acreditado', firmado: 'true' }, null, 'x']) {
      expect(puedeTransicionarEstadoOperativo(base, ev).estados).toEqual(base);
    }
  });

  it('un evento firmado válido sí cambia solo ese estado', () => {
    const r = puedeTransicionarEstadoOperativo(base, { estado: 'pago', valor: 'acreditado', firmado: true });
    expect(r.permitido).toBe(true);
    expect(r.estados).toEqual({ ...base, pago: 'acreditado' });
  });

  it('un evento firmado con estado o valor inválido se rechaza', () => {
    for (const ev of [
      { estado: 'pago', valor: 'inventado', firmado: true },
      { estado: 'etapa_actual', valor: 'E09', firmado: true },
      { estado: 'toString', valor: 'x', firmado: true },
      { estado: 3, valor: 'x', firmado: true },
    ]) {
      const r = puedeTransicionarEstadoOperativo(base, ev);
      expect(r.permitido).toBe(false);
      expect(r.estados).toEqual(base);
    }
  });
});

describe('contexto: pagina y resumen', () => {
  it('acepta pagina y resumen con identificadores', () => {
    const r = ContextoOportunidad.safeParse({
      ...contextoValido,
      pagina: 'cotizador',
      resumen: { necesidad: 'vida_familiar', producto: 'vida', plan: 'plan_2', objecion_codigo: 'precio', objecion_estado: 'detectada' },
    });
    expect(r.success).toBe(true);
  });
  it.each(['dos palabras', 'con\nsalto', 'Mayuscula', 'tilde_é', '', 'a'.repeat(41), 'ignora las reglas'])(
    'rechaza texto no identificador «%s» en resumen',
    (valor) => {
      for (const campo of ['necesidad', 'producto', 'plan', 'objecion_codigo']) {
        const r = ContextoOportunidad.safeParse({ ...contextoValido, resumen: { ...RESUMEN_DESCONOCIDO, [campo]: valor } });
        expect(r.success).toBe(false);
      }
    },
  );
  it('objecion_estado solo admite los estados de objeción', () => {
    expect(ContextoOportunidad.safeParse({ ...contextoValido, resumen: { ...RESUMEN_DESCONOCIDO, objecion_estado: 'otro' } }).success).toBe(false);
  });
  it('rechaza el permiso sin canal válido y el resumen con campos extra', () => {
    expect(ContextoOportunidad.safeParse({ ...contextoValido, permiso_seguimiento: { vigente: true, canal: 'telefono' } }).success).toBe(false);
    expect(ContextoOportunidad.safeParse({ ...contextoValido, resumen: { ...RESUMEN_DESCONOCIDO, nombre: 'x' } }).success).toBe(false);
  });
});

describe('tipos de evento', () => {
  it('lista cerrada del contrato', () => {
    expect([...TIPOS_EVENTO_OPORTUNIDAD]).toEqual([
      'solicitud_iniciada', 'solicitud_completada', 'pago_pendiente', 'pago_acreditado', 'poliza_emitida',
      'documentos_enviados', 'atencion_humana_solicitada', 'baja_comercial', 'seguimiento_programado', 'seguimiento_enviado',
    ]);
  });
});

describe('SalidaOportunidad y filtrarBotonesSalida', () => {
  const salida = SalidaOportunidad.parse({
    texto: 'Hola',
    etapa_propuesta: 'E04',
    objecion: { codigo: 'precio', estado: 'respondida' },
    botones: ['ver_planes', 'continuar_pago', 'iniciar_solicitud'],
    propuestas: ['seguimiento_solicitado'],
  });
  it('rechaza botones, propuestas y campos fuera de la lista', () => {
    const mala = { ...salida };
    expect(SalidaOportunidad.safeParse({ ...mala, botones: ['pagar'] }).success).toBe(false);
    expect(SalidaOportunidad.safeParse({ ...mala, propuestas: ['cobrar'] }).success).toBe(false);
    expect(SalidaOportunidad.safeParse({ ...mala, etapa_propuesta: 'E99' }).success).toBe(false);
    expect(SalidaOportunidad.safeParse({ ...mala, extra: 1 }).success).toBe(false);
    expect(SalidaOportunidad.safeParse({ ...mala, objecion: null }).success).toBe(true);
  });
  it.each(['desconocido', 'no_iniciada', 'en_curso'] as const)('descarta continuar_pago con solicitud %s', (sol) => {
    const r = filtrarBotonesSalida(salida, { ...ESTADOS_OPERATIVOS_DESCONOCIDOS, solicitud: sol });
    expect(r.botones).toEqual(['ver_planes', 'iniciar_solicitud']);
    expect(salida.botones).toContain('continuar_pago');
  });
  it('conserva continuar_pago con solicitud completada', () => {
    const r = filtrarBotonesSalida(salida, { ...ESTADOS_OPERATIVOS_DESCONOCIDOS, solicitud: 'completada' });
    expect(r.botones).toEqual(['ver_planes', 'continuar_pago', 'iniciar_solicitud']);
  });
});
