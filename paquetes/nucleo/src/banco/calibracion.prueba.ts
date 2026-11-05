/** Pruebas de la calibración del banco (H4a). Datos sintéticos. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { VERSION_REGLA_DECISION } from './similitud.js';
import { barrerUmbrales, elegirUmbral, verificarMinimos } from './medir.js';
import type { CasoMedible } from './medir.js';
import type { IndiceSemantico } from './similitud.js';
import { Calibracion, ErrorCalibracion, cargarCalibracion, umbralesDeCalibracion, verificarCalibracion } from './calibracion.js';

const SHA = 'a'.repeat(64);
const buena = (cambios: Record<string, unknown> = {}) => ({
  formato: 1,
  regla: VERSION_REGLA_DECISION,
  banco_sha256: SHA,
  evaluacion_sha256: 'b'.repeat(64),
  proveedor: 'vertex',
  modelo: 'modelo-prueba',
  dimension: 8,
  umbral_fijo: 0.82,
  umbral_derivacion: 0.7,
  margen: 0.05,
  valido: true,
  motivos_invalidez: [],
  control: { total: 120, confusiones: 0, falsos_positivos: 0 },
  medido: '2026-11-04',
  ...cambios,
});
const cal = (cambios: Record<string, unknown> = {}): Calibracion => Calibracion.parse(buena(cambios));
const ESPERADO = { bancoSha256: SHA, modelo: 'modelo-prueba', dimension: 8 };

describe('esquema de calibracion.json', () => {
  it('acepta el archivo bien formado y lo carga desde texto', () => {
    expect(cargarCalibracion(JSON.stringify(buena())).umbral_fijo).toBe(0.82);
    expect(umbralesDeCalibracion(cal())).toEqual({ umbralFijo: 0.82, umbralDerivacion: 0.7, margen: 0.05 });
  });

  it('es estricto: clave de más, SHA mal formado, umbral fuera de rango, fecha mal escrita, motivo desconocido', () => {
    for (const malo of [
      { extra: 1 },
      { banco_sha256: 'abc' },
      { evaluacion_sha256: 'z'.repeat(64) },
      { umbral_fijo: 0 },
      { umbral_derivacion: 1.2 },
      { margen: -0.1 },
      { dimension: 0 },
      { dimension: 1.5 },
      { proveedor: 'otro' },
      { medido: '4/11/2026' },
      { motivos_invalidez: ['inventado'] },
      { control: { total: 1, confusiones: 0 } },
      { control: { total: 1, confusiones: 0, falsos_positivos: 0, otra: 1 } },
      { formato: 2 },
      { regla: 0 },
      { umbral_fijo: 0.49 },
      { umbral_derivacion: 0 },
    ]) {
      expect(Calibracion.safeParse(buena(malo)).success, JSON.stringify(malo)).toBe(false);
    }
  });

  it('exige el campo regla (una calibración de H3, sin él, se rechaza)', () => {
    const sinRegla: Record<string, unknown> = buena();
    delete sinRegla['regla'];
    expect(Calibracion.safeParse(sinRegla).success).toBe(false);
  });

  it('rechaza archivos incoherentes', () => {
    const invalido = { valido: false, motivos_invalidez: ['confusion_en_control'] };
    for (const malo of [
      { valido: true, motivos_invalidez: ['minimos_insuficientes'] }, // válido con motivos
      { valido: false, motivos_invalidez: [] }, // inválido sin motivo
      { ...invalido, control: { total: 120, confusiones: 1, falsos_positivos: 1 } }, // falta el motivo de falso positivo
      { valido: true, control: { total: 120, confusiones: 2, falsos_positivos: 0 } }, // confusiones sin motivo
      { valido: true, control: { total: 120, confusiones: 0, falsos_positivos: 3 } }, // falsos positivos sin motivo
      { control: { total: 0, confusiones: 0, falsos_positivos: 0 } }, // válido con control vacío
      { control: { total: 29, confusiones: 0, falsos_positivos: 0 } }, // bajo el mínimo de «ninguna» de medir.ts
    ]) {
      expect(Calibracion.safeParse(buena(malo)).success, JSON.stringify(malo)).toBe(false);
    }
    // Coherente: inválida, con ambos motivos y control chico (una calibración inválida puede tener poco control).
    expect(
      Calibracion.safeParse(
        buena({ valido: false, motivos_invalidez: ['confusion_en_control', 'falso_positivo_en_control', 'minimos_insuficientes'], control: { total: 5, confusiones: 1, falsos_positivos: 1 } }),
      ).success,
    ).toBe(true);
  });

  it('los errores de carga no muestran valores del archivo', () => {
    expect(() => cargarCalibracion('no es json')).toThrow(ErrorCalibracion);
    try {
      cargarCalibracion(JSON.stringify(buena({ CLAVE_SECRETA_PEGADA: 'valor-secreto-xyz' })));
      expect.unreachable();
    } catch (e) {
      const err = e as ErrorCalibracion;
      expect(`${err.message} ${err.detalles.join(' ')}`).not.toContain('CLAVE_SECRETA_PEGADA');
      expect(`${err.message} ${err.detalles.join(' ')}`).not.toContain('valor-secreto-xyz');
      expect(err.detalles.some((d) => d.endsWith('clave no admitida'))).toBe(true);
    }
  });
});

describe('la salida real de la medición pasa por el esquema', () => {
  const angulo = (g: number): number[] => [Math.cos((g * Math.PI) / 180), Math.sin((g * Math.PI) / 180)];
  const indice: IndiceSemantico = {
    modelo: 'modelo-prueba',
    dimension: 2,
    vectores: [
      { entradaId: 'a', tipo: 'respuesta', vector: angulo(0) },
      { entradaId: 'b', tipo: 'respuesta', vector: angulo(90) },
      { entradaId: 'd', tipo: 'derivacion', vector: angulo(180) },
    ],
  };
  const casos: CasoMedible[] = (['calibracion', 'control'] as const).flatMap((particion) => [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `a${particion}${i}`, vector: angulo(5), esperado: { tipo: 'respuesta' as const, entradaId: 'a' }, particion })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `b${particion}${i}`, vector: angulo(85), esperado: { tipo: 'respuesta' as const, entradaId: 'b' }, particion })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `d${particion}${i}`, vector: angulo(175), esperado: { tipo: 'derivacion' as const, entradaId: 'd' }, particion })),
    ...Array.from({ length: 30 }, (_, i) => ({ id: `n${particion}${i}`, vector: angulo(45), esperado: { tipo: 'ninguna' as const }, particion })),
  ]);

  it.each([0, 0.05, 0.2, 0.6])('--diferencia-derivacion=%f produce una calibración que cargarCalibracion acepta', (diferencia) => {
    const elegido = elegirUmbral(barrerUmbrales(casos, indice, { margen: 0.05, diferenciaDerivacion: diferencia }), verificarMinimos(casos, indice));
    expect(elegido).not.toBeNull();
    if (elegido === null) return;
    const texto = JSON.stringify(
      buena({
        umbral_fijo: elegido.umbralFijo,
        umbral_derivacion: elegido.umbralDerivacion,
        margen: elegido.margen,
        valido: elegido.valido,
        motivos_invalidez: elegido.motivosInvalidez,
        control: { total: elegido.control.total, confusiones: elegido.control.confusiones, falsos_positivos: elegido.control.falsosPositivos },
      }),
    );
    const c = cargarCalibracion(texto);
    expect(c.valido).toBe(true);
    expect(c.umbral_derivacion).toBeGreaterThan(0);
  });

  it('una derivación en el piso del barrido (0,01) es admisible; 0 o negativa no', () => {
    expect(Calibracion.safeParse(buena({ umbral_derivacion: 0.01 })).success).toBe(true);
    expect(Calibracion.safeParse(buena({ umbral_derivacion: 0 })).success).toBe(false);
    expect(Calibracion.safeParse(buena({ umbral_derivacion: -0.1 })).success).toBe(false);
  });
});

describe('verificarCalibracion', () => {
  it('calibración vigente: semántica y fijo aptos', () => {
    expect(verificarCalibracion(cal(), ESPERADO)).toEqual({ semanticaApta: true, fijoApto: true });
  });

  it('el SHA se compara sin distinguir mayúsculas', () => {
    expect(verificarCalibracion(cal({ banco_sha256: 'A'.repeat(64) }), ESPERADO).semanticaApta).toBe(true);
  });

  it.each([
    ['otro SHA del banco', { bancoSha256: 'c'.repeat(64) }, {}],
    ['otro modelo', { modelo: 'otro-modelo' }, {}],
    ['otra dimensión', { dimension: 16 }, {}],
    ['valido: false', {}, { valido: false, motivos_invalidez: ['minimos_insuficientes'] }],
    ['proveedor simulado', {}, { proveedor: 'simulado' }],
  ])('no apta por %s', (_n, esperado, cambios) => {
    expect(verificarCalibracion(cal(cambios), { ...ESPERADO, ...esperado })).toEqual({ semanticaApta: false, fijoApto: false });
  });

  it('el proveedor simulado solo se admite si se pide (pruebas)', () => {
    expect(verificarCalibracion(cal({ proveedor: 'simulado' }), { ...ESPERADO, admitirSimulado: true })).toEqual({ semanticaApta: true, fijoApto: true });
    expect(verificarCalibracion(cal({ proveedor: 'simulado' }), { ...ESPERADO, admitirSimulado: false }).semanticaApta).toBe(false);
  });

  it('D4 con estados coherentes: una confusión o un falso positivo en el control invalidan la calibración entera', () => {
    const conConfusion = cal({ valido: false, motivos_invalidez: ['confusion_en_control'], control: { total: 120, confusiones: 1, falsos_positivos: 0 } });
    const conFalsoPositivo = cal({ valido: false, motivos_invalidez: ['falso_positivo_en_control'], control: { total: 120, confusiones: 0, falsos_positivos: 2 } });
    expect(verificarCalibracion(conConfusion, ESPERADO)).toEqual({ semanticaApta: false, fijoApto: false });
    expect(verificarCalibracion(conFalsoPositivo, ESPERADO)).toEqual({ semanticaApta: false, fijoApto: false });
  });

  it('defensa en profundidad: un objeto que no pasó por el esquema (estado imposible) tampoco habilita el fijo', () => {
    const imposible = { ...cal(), control: { total: 120, confusiones: 1, falsos_positivos: 0 } };
    expect(verificarCalibracion(imposible, ESPERADO)).toEqual({ semanticaApta: true, fijoApto: false });
    expect(verificarCalibracion({ ...cal(), control: { total: 120, confusiones: 0, falsos_positivos: 2 } }, ESPERADO).fijoApto).toBe(false);
  });

  it('una calibración medida con otra versión de la regla de decisión no es apta', () => {
    expect(verificarCalibracion(cal({ regla: VERSION_REGLA_DECISION + 1 }), ESPERADO)).toEqual({ semanticaApta: false, fijoApto: false });
    expect(verificarCalibracion(cal({ regla: VERSION_REGLA_DECISION }), ESPERADO).semanticaApta).toBe(true);
  });
});

describe('estructura', () => {
  it('el archivo no usa red, entorno ni expresiones construidas', () => {
    const fuente = readFileSync(new URL('./calibracion.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Math.random']) expect(fuente).not.toContain(prohibido);
  });
});
