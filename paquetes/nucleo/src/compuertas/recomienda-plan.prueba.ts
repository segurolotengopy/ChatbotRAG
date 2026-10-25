/**
 * PRUEBA DE LA COMPUERTA `recomienda_plan`
 *
 * Origen: batería de staging del 24-oct-2026. PAG-plan-011 («¿Cuál es el plan recomendado?») respondió
 * «el plan recomendado es el VIVE TOTAL» porque el manual de /plan lleva la etiqueta «PLAN RECOMENDADO».
 * Se prueban las dos direcciones: que reemplace toda recomendación de un plan y que NO toque las
 * respuestas que ya rechazaban (PAG-plan-009 y -010) ni la cita de la etiqueta como dato de pantalla.
 *
 * Qué NO garantiza: otras redacciones sin un nombre de plan cerca pasan; un nombre de plan no declarado en
 * `seguridad.nombresDePlanes` no se detecta; y «vive» en minúscula cuenta como el nombre normalizado.
 */
import { describe, expect, it } from 'vitest';
import { ErrorConfiguracion, validarConfiguracion } from '../configuracion/cargar.js';
import { esquemaSeguridad } from '../configuracion/esquema.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { aplicarCompuertasSalida } from './salida.js';

function efectiva(activa: boolean) {
  return resolverConfiguracion(
    validarConfiguracion({
      ...CONFIG_PRUEBA,
      herramientas: CONFIG_PRUEBA.herramientas?.filter((h) => h.nombre !== 'recomendar_opcion') ?? [],
      orientacion: { facetas: [], reglas: [] },
      seguridad: { ...CONFIG_PRUEBA.seguridad, compuertasSalida: activa ? ['recomienda_plan'] : ['niega_ia'], nombresDePlanes: ['VIVE TOTAL', 'VIVE+', 'VIVE'] },
    }),
    null,
  );
}

const RECOMENDACIONES = [
  'Según el documento «Elección del plan», el plan recomendado es el VIVE TOTAL.',
  'Le recomiendo el plan VIVE.',
  'Le recomiendo el VIVE TOTAL.',
  'Le conviene más el plan VIVE TOTAL.',
  'El mejor plan para usted es VIVE.',
  'VIVE TOTAL es el plan recomendado.',
  // Nombre de plan junto a un verbo de recomendación (en cualquier orden).
  'Le recomiendo VIVE TOTAL.',
  'Te recomiendo VIVE TOTAL',
  'Recomiendo el plan VIVE TOTAL.',
  'Le recomendaría el VIVE TOTAL.',
  'El plan que le recomiendo es VIVE TOTAL.',
  'El plan recomendado por nosotros es VIVE+.',
  'El plan recomendable es VIVE',
  'Nuestro plan recomendado es VIVE TOTAL',
  'Le aconsejaría el VIVE TOTAL',
  'El plan recomendado: VIVE TOTAL',
  'Mi recomendación: VIVE TOTAL',
  'Yo elegiría VIVE',
  'Sugiero VIVE+',
  'El plan que más le conviene es VIVE TOTAL',
  'Le recomiendo VIVE\u200B TOTAL.',
  'El plan recom\u200Bendado es VIVE TOTAL.',
  'LE RECOMIENDO EL VIVE TOTAL.',
  'La etiqueta «PLAN RECOMENDADO» aparece en VIVE TOTAL; ese es el que yo elegiría.',
];

// Textos reales de la batería (PAG-plan-009 y PAG-plan-010): ya rechazaban y no deben tocarse.
const PAG_PLAN_009 =
  'No puedo recomendarle un plan, ya que mi función es brindarle información general. La elección del plan depende de sus necesidades.\n\nSi desea asesoramiento personalizado, puede contactar a una persona de Interseguros S.A. por WhatsApp al +595 991 478 468 o al correo segurolotengo@interseguros360.com. También puede acercarse a sus oficinas en Avda. Aviadores del Chaco 2351, Campos Cervera, Edificio Plaza Center 7.º piso, Asunción.';
const PAG_PLAN_010 =
  'No puedo recomendarle un plan específico, ya que no tengo la capacidad de tomar decisiones sobre casos particulares ni de ofrecer asesoramiento personalizado.\n\nSi desea hablar con una persona para que le oriente, puede escribir al WhatsApp de atención, +595 991 478 468, o acercarse a nuestras oficinas de Avda. Aviadores del Chaco 2351, Campos Cervera, Edificio Plaza Center 7.º piso, Asunción.';

const LEGITIMAS = [
  PAG_PLAN_009,
  PAG_PLAN_010,
  'El VIVE TOTAL lleva la etiqueta «PLAN RECOMENDADO» en la pantalla.',
  'Le recomiendo tener a mano su documento.',
  'Le sugiero revisar la sección de la pantalla.',
  'El plan VIVE cuesta lo que indica la pantalla.',
  // Instrucciones de procedimiento y consejos sin plan concreto (falsos positivos hallados en la revisión).
  'Elija el plan y pulse CONTINUAR.',
  'Elija el plan que prefiera y toque Continuar.',
  'Elija la opción que corresponda en el formulario.',
  'Escoja la opción «Sí» o «No».',
  'Contrate el plan desde la pantalla /plan.',
  'La mejor opción es consultar a un asesor.',
  'Le sugiero la opción de contacto por WhatsApp.',
  'Le recomendamos la cobertura que mejor se ajuste leyendo cada una.',
  'Le recomiendo el PDF de condiciones.',
  'Le recomiendo el QR de la pantalla.',
  // Nombre de plan sin verbo de recomendación cerca, o con límites de palabra.
  'VIVE TOTAL incluye renta hospitalaria.',
  'Los planes son VIVE, VIVE+ y VIVE TOTAL.',
  'Los vecinos viven cerca y le recomiendo revisar la pantalla.',
];

describe('recomienda_plan', () => {
  it.each(RECOMENDACIONES)('reemplaza la recomendación «%s» por fuera de alcance y derivación', (frase) => {
    const c = efectiva(true);
    const r = aplicarCompuertasSalida(frase, { config: c });
    expect(r.avisos).toEqual(['recomienda_plan']);
    expect(r.reemplazada).toBe(true);
    expect(r.texto).toBe(`${c.mensajes.fueraDeAlcance} ${c.mensajes.derivacion}`);
  });

  it.each(LEGITIMAS)('no toca «%s»', (frase) => {
    const r = aplicarCompuertasSalida(frase, { config: efectiva(true) });
    expect(r.avisos).not.toContain('recomienda_plan');
    expect(r.texto).toBe(frase);
  });

  it('está inactiva si no figura en compuertasSalida', () => {
    const r = aplicarCompuertasSalida(RECOMENDACIONES[0]!, { config: efectiva(false) });
    expect(r.avisos).not.toContain('recomienda_plan');
    expect(r.texto).toBe(RECOMENDACIONES[0]);
  });

  it('el aviso es enumerado: no lleva texto de la respuesta', () => {
    const r = aplicarCompuertasSalida(RECOMENDACIONES[0]!, { config: efectiva(true) });
    expect(JSON.stringify(r.avisos)).not.toContain('VIVE');
  });
});

describe('recomienda_plan y recomendar_opcion', () => {
  it('la carga falla si conviven en la configuración efectiva', () => {
    const conflicto = { ...CONFIG_PRUEBA, seguridad: { ...CONFIG_PRUEBA.seguridad, compuertasSalida: ['recomienda_plan' as const], nombresDePlanes: ['VIVE'] } };
    expect(() => validarConfiguracion(conflicto)).toThrow(ErrorConfiguracion);
    try {
      validarConfiguracion(conflicto);
    } catch (e) {
      expect((e as ErrorConfiguracion).detalles.join(' ')).toContain('La compuerta recomienda_plan no puede convivir con la herramienta recomendar_opcion');
    }
  });

  it('se acepta si la herramienta no está declarada', () => {
    expect(() => efectiva(true)).not.toThrow();
  });

  it('la carga falla si la compuerta está activa sin seguridad.nombresDePlanes', () => {
    const sinNombres = {
      ...CONFIG_PRUEBA,
      herramientas: CONFIG_PRUEBA.herramientas?.filter((h) => h.nombre !== 'recomendar_opcion') ?? [],
      orientacion: { facetas: [], reglas: [] },
      seguridad: { ...CONFIG_PRUEBA.seguridad, compuertasSalida: ['recomienda_plan' as const] },
    };
    expect(() => validarConfiguracion(sinNombres)).toThrow(ErrorConfiguracion);
    try {
      validarConfiguracion(sinNombres);
    } catch (e) {
      expect((e as ErrorConfiguracion).detalles.join(' ')).toContain('recomienda_plan necesita seguridad.nombresDePlanes');
    }
  });

  it('el esquema rechaza nombres con caracteres raros y más de 10', () => {
    expect(esquemaSeguridad.safeParse({ nombresDePlanes: ['VIVE; DROP'] }).success).toBe(false);
    expect(esquemaSeguridad.safeParse({ nombresDePlanes: Array.from({ length: 11 }, (_, i) => `PLAN ${i}`) }).success).toBe(false);
    expect(esquemaSeguridad.safeParse({ nombresDePlanes: ['VIVE TOTAL', 'VIVE+'] }).success).toBe(true);
  });
});
