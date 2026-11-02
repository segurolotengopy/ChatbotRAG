/**
 * PRUEBA DE `seguridad.marcasLiterales`
 *
 * Origen: batería de staging del 24-oct-2026. PAG-retracto-007 respondió «el plazo para retractarse está "".»
 * porque el manual trae `[PENDIENTE DE DEFINICIÓN LEGAL]` (28 caracteres entre corchetes) y la compuerta
 * borra todo `[X]` que no sea una marca de control. Se fija: la marca literal declarada se conserva sin
 * aviso; las demás siguen borrándose; las permitidas siguen extrayéndose; y el esquema y la carga rechazan
 * las configuraciones ambiguas.
 *
 * Qué NO garantiza: que el modelo cite la marca; solo que, si la cita, llega intacta.
 */
import { describe, expect, it } from 'vitest';
import { ErrorConfiguracion, validarConfiguracion } from '../configuracion/cargar.js';
import { esquemaSeguridad } from '../configuracion/esquema.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { aplicarCompuertasSalida, extraerMarcas } from './salida.js';

const LITERALES = ['PENDIENTE_DE_DEFINICION_LEGAL'];
const PERMITIDAS = ['DERIVAR'];
const TEXTO = 'La página de Derecho de retracto indica que el plazo para retractarse está [PENDIENTE DE DEFINICIÓN LEGAL], por lo que no contamos con ese dato.';

function efectiva(literales: string[]) {
  return resolverConfiguracion(
    validarConfiguracion({
      ...CONFIG_PRUEBA,
      seguridad: { ...CONFIG_PRUEBA.seguridad, marcasLiterales: literales },
    }),
    null,
  );
}

describe('extraerMarcas con marcas literales', () => {
  it('conserva la marca literal sin contarla ni como marca ni como borrada', () => {
    const r = extraerMarcas(TEXTO, PERMITIDAS, LITERALES);
    expect(r.texto).toBe(TEXTO);
    expect(r.marcas).toEqual([]);
    expect(r.borradas).toBe(0);
  });

  it('conserva la variante con tildes, sin tildes o en minúsculas (misma clave normalizada)', () => {
    for (const v of ['[PENDIENTE DE DEFINICIÓN LEGAL]', '[Pendiente de definición legal]', '[pendiente de definicion legal]']) {
      const texto = `El plazo está ${v}.`;
      expect(extraerMarcas(texto, PERMITIDAS, LITERALES)).toEqual({ texto, marcas: [], borradas: 0 });
    }
  });

  it('sigue borrando una marca inventada y extrayendo una permitida', () => {
    const r = extraerMarcas('Listo [CONFIRMADO] y [DERIVAR] pendiente [PENDIENTE DE DEFINICIÓN LEGAL].', PERMITIDAS, LITERALES);
    expect(r.texto).toBe('Listo y pendiente [PENDIENTE DE DEFINICIÓN LEGAL].');
    expect(r.marcas).toEqual(['DERIVAR']);
    expect(r.borradas).toBe(1);
  });

  it('sin literales declaradas, el comportamiento es el de siempre (se borra)', () => {
    const r = extraerMarcas(TEXTO, PERMITIDAS);
    expect(r.texto).not.toContain('PENDIENTE');
    expect(r.borradas).toBe(1);
  });
});

describe('compuerta marca_no_declarada con marcas literales', () => {
  it('no avisa ni modifica el texto cuando la marca es literal', () => {
    const r = aplicarCompuertasSalida(TEXTO, { config: efectiva(LITERALES) });
    expect(r.texto).toBe(TEXTO);
    expect(r.avisos).not.toContain('marca_no_declarada');
  });

  it('sin la declaración borra la marca y avisa', () => {
    const r = aplicarCompuertasSalida(TEXTO, { config: efectiva([]) });
    expect(r.texto).not.toContain('PENDIENTE');
    expect(r.avisos).toContain('marca_no_declarada');
  });

  it('una marca inventada se borra aunque haya literales declaradas', () => {
    const r = aplicarCompuertasSalida('Todo [CONFIRMADO] bien.', { config: efectiva(LITERALES) });
    expect(r.texto).toBe('Todo bien.');
    expect(r.avisos).toContain('marca_no_declarada');
  });
});

describe('esquema y carga de marcasLiterales', () => {
  it('por omisión es una lista vacía', () => {
    expect(esquemaSeguridad.parse({}).marcasLiterales).toEqual([]);
  });

  it('el esquema rechaza minúsculas y más de 10 elementos', () => {
    expect(esquemaSeguridad.safeParse({ marcasLiterales: ['pendiente legal'] }).success).toBe(false);
    expect(esquemaSeguridad.safeParse({ marcasLiterales: Array.from({ length: 11 }, (_, i) => `MARCA_${'A'.repeat(i + 1)}`) }).success).toBe(false);
    expect(esquemaSeguridad.safeParse({ marcasLiterales: LITERALES }).success).toBe(true);
  });

  it('la carga falla si la marca está en marcasLiterales y en marcasPermitidas', () => {
    const doble = { ...CONFIG_PRUEBA, seguridad: { ...CONFIG_PRUEBA.seguridad, marcasPermitidas: ['DERIVAR', 'PENDIENTE_LEGAL'], marcasLiterales: ['PENDIENTE_LEGAL'] } };
    expect(() => validarConfiguracion(doble)).toThrow(ErrorConfiguracion);
    try {
      validarConfiguracion(doble);
    } catch (e) {
      expect((e as ErrorConfiguracion).detalles.join(' ')).toContain('marcasLiterales y marcasPermitidas no pueden compartir una marca');
    }
  });
});
