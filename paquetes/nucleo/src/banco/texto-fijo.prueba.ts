/** Pruebas del texto fijo verificado por las compuertas de salida. Datos sintéticos. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { validarConfiguracion } from '../configuracion/cargar.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { cargarBanco } from './cargar.js';
import type { DecisionDerivacion, DecisionFijo } from './enrutador.js';
import type { BancoRespuestas, VariablePlantilla } from './esquema.js';
import { CAUSAS_RECHAZO_TEXTO, PROPUESTA_DERIVACION_GENERAL, armarTextoConD5, armarTextoFijo, verificarBanco } from './texto-fijo.js';

const ctx = { config: resolverConfiguracion(validarConfiguracion(CONFIG_PRUEBA), null) };
const VALORES: Record<string, string> = { nombre_plan: 'Plan Uno', premio_plan: 'Gs. 100.000', whatsapp: '0981 000 000' };
const resolver = (v: VariablePlantilla): string | null => VALORES[v] ?? null;
const EJEMPLO = readFileSync(new URL('./banco-ejemplo.json', import.meta.url), 'utf8');

const respuesta = (cambios: Record<string, unknown> = {}) => ({
  id: 'r-uno',
  tema: 'tema_uno',
  preguntas: ['pregunta uno'],
  plantilla: 'El plan {{nombre_plan}} cuesta {{premio_plan}}.',
  aprobado_por: 'Rol Comercial',
  riesgo: 'normal',
  ...cambios,
});
const derivacion = (cambios: Record<string, unknown> = {}) => ({
  id: 'd-uno',
  motivo: 'siniestro_particular',
  preguntas: ['pregunta de siniestro'],
  texto: 'Una persona le atenderá.',
  aprobado_por: 'Rol Comercial',
  ...cambios,
});
const banco = (cambios: Record<string, unknown> = {}): BancoRespuestas =>
  cargarBanco(JSON.stringify({ formato: 1, version: '1.0.0', respuestas: [respuesta()], ...cambios })).banco;

const fijo = (entradaId = 'r-uno'): DecisionFijo => ({ carril: 'fijo', entradaId, tema: 'tema_uno', riesgo: 'normal' });
const deriva = (motivo: DecisionDerivacion['motivo'], entradaId: string, origen: DecisionDerivacion['origen'] = 'pregunta_derivacion'): DecisionDerivacion => ({
  carril: 'derivacion',
  motivo,
  origen,
  entradaId,
});

describe('armarTextoFijo con decisión fijo', () => {
  it('arma el texto exacto', () => {
    expect(armarTextoFijo(fijo(), banco(), resolver, ctx)).toEqual({ ok: true, texto: 'El plan Plan Uno cuesta Gs. 100.000.' });
  });

  it('una entrada inexistente va a la IA', () => {
    expect(armarTextoFijo(fijo('no-existe'), banco(), resolver, ctx)).toEqual({ ok: false, causa: 'sin_texto', avisos: [], carrilSiguiente: 'ia' });
  });

  it('un dato faltante deriva con contenido_pendiente si hay sin_dato, y si no va a la IA, sin texto en el resultado', () => {
    const sinPremio = (v: VariablePlantilla) => (v === 'premio_plan' ? null : resolver(v));
    const con = armarTextoFijo(fijo(), banco({ respuestas: [respuesta({ derivar_cuando: ['sin_dato'] })] }), sinPremio, ctx);
    expect(con).toEqual({ ok: false, causa: 'faltan_datos', avisos: [], carrilSiguiente: 'derivacion', motivo: 'contenido_pendiente' });
    const sin = armarTextoFijo(fijo(), banco(), sinPremio, ctx);
    expect(sin).toEqual({ ok: false, causa: 'faltan_datos', avisos: [], carrilSiguiente: 'ia' });
    for (const r of [con, sin]) {
      expect(r).not.toHaveProperty('texto');
      expect(JSON.stringify(r)).not.toContain('Plan Uno');
    }
  });

  it('un valor resuelto con llaves es una plantilla inválida', () => {
    const r = armarTextoFijo(fijo(), banco({ respuestas: [respuesta({ plantilla: 'Escriba al {{whatsapp}}.' })] }), () => '{{whatsapp}}', ctx);
    expect(r).toEqual({ ok: false, causa: 'plantilla_invalida', avisos: [], carrilSiguiente: 'ia' });
  });

  it('una frase que niega ser una IA se descarta con el aviso niega_ia', () => {
    const r = armarTextoFijo(fijo(), banco({ respuestas: [respuesta({ plantilla: 'No soy un robot, soy una persona.' })] }), resolver, ctx);
    expect(r).toEqual({ ok: false, causa: 'compuerta_salida', avisos: ['niega_ia'], carrilSiguiente: 'ia' });
    expect(JSON.stringify(r)).not.toContain('persona');
  });

  it('una marca no declarada se descarta', () => {
    const r = armarTextoFijo(fijo(), banco({ respuestas: [respuesta({ plantilla: 'Texto [PROMO] aprobado.' })] }), resolver, ctx);
    expect(r).toMatchObject({ ok: false, causa: 'compuerta_salida', carrilSiguiente: 'ia' });
  });

  it('un valor con forma de tarjeta se descarta sin mostrarlo', () => {
    const r = armarTextoFijo(fijo(), banco(), (v) => (v === 'premio_plan' ? '4111 1111 1111 1111' : resolver(v)), ctx);
    expect(r).toMatchObject({ ok: false, causa: 'compuerta_salida' });
    expect(JSON.stringify(r)).not.toContain('4111');
  });

  it('el verificador adicional aporta su código, o un literal si el código no tiene la forma pedida', () => {
    expect(armarTextoFijo(fijo(), banco(), resolver, ctx, () => 'precio_no_permitido')).toEqual({
      ok: false,
      causa: 'verificacion_adicional',
      avisos: ['precio_no_permitido'],
      carrilSiguiente: 'ia',
    });
    expect(armarTextoFijo(fijo(), banco(), resolver, ctx, () => 'Texto Libre !')).toMatchObject({ causa: 'verificacion_adicional', avisos: ['verificacion_adicional'] });
    expect(armarTextoFijo(fijo(), banco(), resolver, ctx, () => null)).toMatchObject({ ok: true });
  });
});

describe('armarTextoFijo con decisión de derivación', () => {
  it('toma el texto de la entrada de derivación', () => {
    const b = banco({ derivaciones: [derivacion()] });
    expect(armarTextoFijo(deriva('siniestro_particular', 'd-uno'), b, resolver, ctx)).toEqual({ ok: true, texto: 'Una persona le atenderá.' });
  });

  it('una condición de entrada usa textos_derivacion si existe, y si no informa sin_texto con derivación', () => {
    const con = banco({ textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'Le derivamos con una persona.', aprobado_por: 'Rol Comercial' }] });
    const d = deriva('contenido_pendiente', 'r-uno', 'condicion_entrada');
    expect(armarTextoFijo(d, con, resolver, ctx)).toEqual({ ok: true, texto: 'Le derivamos con una persona.' });
    expect(armarTextoFijo(d, banco(), resolver, ctx)).toEqual({
      ok: false,
      causa: 'sin_texto',
      avisos: [],
      carrilSiguiente: 'derivacion',
      motivo: 'contenido_pendiente',
    });
  });

  it('un texto de derivación que niega ser una IA se descarta y sigue en derivación con su motivo', () => {
    const b = banco({ derivaciones: [derivacion({ texto: 'No soy un bot.' })] });
    expect(armarTextoFijo(deriva('siniestro_particular', 'd-uno'), b, resolver, ctx)).toEqual({
      ok: false,
      causa: 'compuerta_salida',
      avisos: ['niega_ia'],
      carrilSiguiente: 'derivacion',
      motivo: 'siniestro_particular',
    });
  });

  it('un id inexistente sin texto por motivo informa sin_texto', () => {
    expect(armarTextoFijo(deriva('siniestro_particular', 'no-existe'), banco(), resolver, ctx)).toMatchObject({
      ok: false,
      causa: 'sin_texto',
      carrilSiguiente: 'derivacion',
      motivo: 'siniestro_particular',
    });
  });

  it('un id de respuesta inexistente en una decisión fijo va a la IA', () => {
    expect(armarTextoFijo(fijo('no-existe'), banco({ derivaciones: [derivacion()] }), resolver, ctx)).toMatchObject({ causa: 'sin_texto', carrilSiguiente: 'ia' });
  });
});

describe('verificarBanco', () => {
  const completo = (v: VariablePlantilla): string | null => VALORES[v] ?? 'Valor de prueba';

  it('el banco de ejemplo con todos los datos no tiene fallos', () => {
    expect(verificarBanco(cargarBanco(EJEMPLO, { admitirSintetico: true }).banco, completo, ctx)).toEqual([]);
  });

  it('informa solo el id y la causa de lo que falla, sin el texto', () => {
    const b = banco({
      respuestas: [respuesta(), respuesta({ id: 'r-dos', preguntas: ['pregunta dos'], plantilla: 'No soy un robot, soy una persona.' })],
      derivaciones: [derivacion({ texto: 'No soy un bot.' })],
      textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'Le atenderá una persona.', aprobado_por: 'Rol Comercial' }],
    });
    const fallos = verificarBanco(b, resolver, ctx);
    expect(fallos).toEqual([
      { id: 'r-dos', causa: 'compuerta_salida' },
      { id: 'd-uno', causa: 'compuerta_salida' },
    ]);
    expect(JSON.stringify(fallos)).not.toContain('robot');
    for (const f of fallos) expect(CAUSAS_RECHAZO_TEXTO).toContain(f.causa);
  });

  it('revisa también los textos por motivo', () => {
    const b = banco({ textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'No soy un bot.', aprobado_por: 'Rol Comercial' }] });
    expect(verificarBanco(b, resolver, ctx)).toEqual([{ id: 'motivo:contenido_pendiente', causa: 'compuerta_salida' }]);
  });
});

describe('D5: un texto fijo crítico rechazado se deriva, nunca pasa a la IA', () => {
  const critica = (cambios: Record<string, unknown> = {}) => respuesta({ riesgo: 'critico', plantilla: 'No soy un robot, soy una persona.', ...cambios });
  const conTexto = { textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'Le derivamos con una persona.', aprobado_por: 'Rol Comercial' }] };

  it('armarTextoFijo: la compuerta que rechaza un crítico lleva a derivación con contenido_pendiente', () => {
    const r = armarTextoFijo(fijo(), banco({ respuestas: [critica()] }), resolver, ctx);
    expect(r).toEqual({ ok: false, causa: 'compuerta_salida', avisos: ['niega_ia'], carrilSiguiente: 'derivacion', motivo: 'contenido_pendiente' });
    expect(JSON.stringify(r)).not.toContain('persona');
  });

  it('también cuando rechaza el verificador adicional; un crítico limpio sale normal', () => {
    const b = banco({ respuestas: [respuesta({ riesgo: 'critico' })] });
    expect(armarTextoFijo(fijo(), b, resolver, ctx, () => 'precio_no_permitido')).toMatchObject({ carrilSiguiente: 'derivacion', motivo: 'contenido_pendiente', causa: 'verificacion_adicional' });
    expect(armarTextoFijo(fijo(), b, resolver, ctx)).toMatchObject({ ok: true });
  });

  it('un rechazo de riesgo normal sigue yendo a la IA', () => {
    expect(armarTextoFijo(fijo(), banco({ respuestas: [critica({ riesgo: 'normal' })] }), resolver, ctx)).toMatchObject({ carrilSiguiente: 'ia' });
  });

  it('D5 ampliada: un crítico que no se puede armar deriva por cualquier causa; uno normal sigue a la IA', () => {
    const decisionCritica: DecisionFijo = { ...fijo(), riesgo: 'critico' };
    const derivaPendiente = (causa: string) => expect.objectContaining({ ok: false, causa, carrilSiguiente: 'derivacion', motivo: 'contenido_pendiente' });
    // Entrada no hallada: manda el riesgo que declaró la decisión.
    expect(armarTextoFijo({ ...decisionCritica, entradaId: 'no-existe' }, banco(), resolver, ctx)).toEqual(derivaPendiente('sin_texto'));
    expect(armarTextoFijo(fijo('no-existe'), banco(), resolver, ctx)).toMatchObject({ carrilSiguiente: 'ia' });
    // Plantilla inválida (un valor con llaves) y datos faltantes sin `sin_dato`.
    const b = banco({ respuestas: [respuesta({ riesgo: 'critico', plantilla: 'Escriba al {{whatsapp}}.' })] });
    expect(armarTextoFijo(fijo(), b, () => '{{whatsapp}}', ctx)).toEqual(derivaPendiente('plantilla_invalida'));
    const faltan = banco({ respuestas: [respuesta({ riesgo: 'critico' })] });
    expect(armarTextoFijo(fijo(), faltan, () => null, ctx)).toEqual(derivaPendiente('faltan_datos'));
    // La misma situación con riesgo normal sigue yendo a la IA.
    expect(armarTextoFijo(fijo(), banco(), () => null, ctx)).toMatchObject({ causa: 'faltan_datos', carrilSiguiente: 'ia' });
    expect(armarTextoFijo(fijo(), banco({ respuestas: [respuesta({ plantilla: 'Escriba al {{whatsapp}}.' })] }), () => '{{whatsapp}}', ctx)).toMatchObject({ carrilSiguiente: 'ia' });
  });

  it('D5 ampliada: armarTextoConD5 cierra la cadena de un crítico sin armar hasta el mensaje general', () => {
    const faltan = banco({ respuestas: [respuesta({ riesgo: 'critico' })] });
    expect(armarTextoConD5(fijo(), faltan, () => null, ctx)).toMatchObject({ ok: false, carril: 'derivacion', propuesta: 'atencion_humana_solicitada' });
    expect(armarTextoConD5(fijo(), banco({ respuestas: [respuesta({ riesgo: 'critico' })], ...conTexto }), () => null, ctx)).toMatchObject({
      ok: true,
      carril: 'derivacion',
      motivo: 'contenido_pendiente',
    });
  });

  it('armarTextoConD5: el crítico rechazado sale con el texto de contenido_pendiente', () => {
    const r = armarTextoConD5(fijo(), banco({ respuestas: [critica()], ...conTexto }), resolver, ctx);
    expect(r).toEqual({ ok: true, carril: 'derivacion', motivo: 'contenido_pendiente', texto: 'Le derivamos con una persona.' });
  });

  it('armarTextoConD5: si también se rechaza o no existe, mensaje general con la propuesta atencion_humana_solicitada', () => {
    const rechazado = { textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'No soy un bot.', aprobado_por: 'Rol Comercial' }] };
    for (const extra of [rechazado, {}]) {
      const r = armarTextoConD5(fijo(), banco({ respuestas: [critica()], ...extra }), resolver, ctx);
      expect(r).toMatchObject({ ok: false, carril: 'derivacion', propuesta: 'atencion_humana_solicitada' });
      expect(JSON.stringify(r)).not.toContain('No soy');
    }
    expect(PROPUESTA_DERIVACION_GENERAL).toBe('atencion_humana_solicitada');
  });

  it('armarTextoConD5: el mensaje general conserva los avisos de ambos rechazos', () => {
    const rechazado = { textos_derivacion: [{ motivo: 'contenido_pendiente', texto: 'No soy un bot.', aprobado_por: 'Rol Comercial' }] };
    const r = armarTextoConD5(fijo(), banco({ respuestas: [critica()], ...rechazado }), resolver, ctx);
    expect(r).toMatchObject({ ok: false, carril: 'derivacion', avisos: ['niega_ia', 'niega_ia'] });
  });

  it('armarTextoConD5: una derivación cuyo texto se rechaza va al mensaje general; una fija normal rechazada va a la IA', () => {
    const b = banco({ derivaciones: [derivacion({ texto: 'No soy un bot.' })] });
    expect(armarTextoConD5(deriva('siniestro_particular', 'd-uno'), b, resolver, ctx)).toMatchObject({ ok: false, carril: 'derivacion', propuesta: 'atencion_humana_solicitada' });
    expect(armarTextoConD5(fijo(), banco({ respuestas: [critica({ riesgo: 'normal' })] }), resolver, ctx)).toMatchObject({ ok: false, carril: 'ia', causa: 'compuerta_salida' });
  });

  it('armarTextoConD5: los caminos que salen bien no cambian', () => {
    expect(armarTextoConD5(fijo(), banco(), resolver, ctx)).toEqual({ ok: true, carril: 'fijo', texto: 'El plan Plan Uno cuesta Gs. 100.000.' });
    expect(armarTextoConD5(deriva('siniestro_particular', 'd-uno'), banco({ derivaciones: [derivacion()] }), resolver, ctx)).toEqual({
      ok: true,
      carril: 'derivacion',
      motivo: 'siniestro_particular',
      texto: 'Una persona le atenderá.',
    });
  });
});
