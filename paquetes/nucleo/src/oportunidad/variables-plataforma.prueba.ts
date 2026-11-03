/** Pruebas de las variables de plantilla desde la plataforma. Datos sintéticos. */
import { describe, expect, it } from 'vitest';
import { VARIABLES_PLANTILLA } from '../banco/esquema.js';
import { rellenarPlantilla } from '../banco/plantillas.js';
import { Plataforma } from './esquemas.js';
import { patronEnlaceOPrecio, permitidosDe } from './salida-kuaa.js';
import { resolverVariablesPlataforma } from './variables-plataforma.js';

const plan = {
  producto: 'VIDA_ONCOLOGICO',
  plan: 'CONFIO',
  nombre: 'Confio Basico',
  premio_anual_gs: 390000,
  capital_fallecimiento_gs: 20000000,
  indemnizacion_cancer_gs: 10000000,
  renta_hospitalaria_dia_gs: 100000,
  renta_dias_max: 30,
  gastos_medicos_accidente_gs: 2000000,
};
const crear = (cambios: Record<string, unknown> = {}) =>
  Plataforma.parse({
    version: 'v0.4',
    catalogo: [{ producto: 'VIDA_ONCOLOGICO', nombre: 'Vida con cobertura oncológica', estado: 'disponible' }],
    planes: [plan],
    contacto: { whatsapp_e164: '+595991478468', canal: 'WhatsApp SLT', correo_derechos: 'derechos@ejemplo.com.py' },
    ...cambios,
  });

describe('resolverVariablesPlataforma', () => {
  it('da el valor formateado de cada variable', () => {
    const r = resolverVariablesPlataforma(crear(), 'CONFIO');
    expect(r('nombre_plan')).toBe('Confio Basico');
    expect(r('premio_plan')).toBe('390.000');
    expect(r('capital_fallecimiento_plan')).toBe('20.000.000');
    expect(r('indemnizacion_cancer_plan')).toBe('10.000.000');
    expect(r('renta_hospitalaria_dia_plan')).toBe('100.000');
    expect(r('renta_dias_max_plan')).toBe('30');
    expect(r('gastos_medicos_accidente_plan')).toBe('2.000.000');
    expect(r('whatsapp')).toBe('+595 991 478 468');
    expect(r('canal_contacto')).toBe('WhatsApp SLT');
    expect(r('correo_derechos')).toBe('derechos@ejemplo.com.py');
  });

  it('con plan ninguno, las variables de plan son null y las de contacto siguen', () => {
    const r = resolverVariablesPlataforma(crear(), 'ninguno');
    expect(r('premio_plan')).toBeNull();
    expect(r('nombre_plan')).toBeNull();
    expect(r('whatsapp')).toBe('+595 991 478 468');
  });

  it('con un plan ausente de la plataforma, las variables de plan son null', () => {
    const r = resolverVariablesPlataforma(crear(), 'CONFIO_TOTAL');
    expect(r('premio_plan')).toBeNull();
  });

  it('sin plataforma, todo es null', () => {
    const r = resolverVariablesPlataforma(undefined, 'CONFIO');
    for (const v of VARIABLES_PLANTILLA) expect(r(v)).toBeNull();
  });

  it('sin whatsapp, canal ni correo, devuelve null', () => {
    const r = resolverVariablesPlataforma(crear({ contacto: {} }), 'CONFIO');
    expect(r('whatsapp')).toBeNull();
    expect(r('canal_contacto')).toBeNull();
    expect(r('correo_derechos')).toBeNull();
  });

  it('el texto armado con importes y teléfono pasa el detector de la salida', () => {
    const p = crear();
    const plantilla =
      '{{nombre_plan}}: {{premio_plan}} al año; {{capital_fallecimiento_plan}}; {{indemnizacion_cancer_plan}}; ' +
      '{{renta_hospitalaria_dia_plan}} por día hasta {{renta_dias_max_plan}} días; {{gastos_medicos_accidente_plan}}. ' +
      'Escriba al {{whatsapp}} o a {{correo_derechos}}.';
    const r = rellenarPlantilla(plantilla, resolverVariablesPlataforma(p, 'CONFIO'));
    expect(r.ok).toBe(true);
    if (r.ok) expect(patronEnlaceOPrecio(r.texto, permitidosDe(p))).toBeNull();
  });
});
