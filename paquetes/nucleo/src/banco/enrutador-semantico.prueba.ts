/** Pruebas del enrutador con semántica (H4a). Vectores a mano de dos dimensiones; sin embeddings reales. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { Calibracion } from './calibracion.js';
import { VERSION_REGLA_DECISION } from './similitud.js';
import { cargarBanco } from './cargar.js';
import { enrutar, prepararEnrutador } from './enrutador.js';
import type { EstadoEnrutador } from './enrutador.js';
import { enrutarConSemantica, eventoEnrutador } from './enrutador-semantico.js';
import type { ConsultaSemantica, ContextoSemantico } from './enrutador-semantico.js';
import type { IndiceSemantico } from './similitud.js';

const BANCO = cargarBanco(readFileSync(new URL('./banco-ejemplo.json', import.meta.url), 'utf8'), { admitirSintetico: true });
const INDICE = prepararEnrutador(BANCO.banco, BANCO.sha256);
const ON = { activo: true, carrilFijo: true };
const SIN_ATENCION: EstadoEnrutador = { atencionHumanaSolicitada: false };
const angulo = (grados: number): number[] => [Math.cos((grados * Math.PI) / 180), Math.sin((grados * Math.PI) / 180)];
const OTRO = 'una frase que no esta en el banco';

const INDICE_SEMANTICO: IndiceSemantico = {
  modelo: 'modelo-prueba',
  dimension: 2,
  vectores: [
    { entradaId: 'ejemplo-siniestro', tipo: 'derivacion', vector: angulo(180) },
    { entradaId: 'ejemplo-precio-1', tipo: 'respuesta', vector: angulo(0) },
    { entradaId: 'ejemplo-contacto', tipo: 'respuesta', vector: angulo(90) },
    { entradaId: 'ejemplo-pendiente', tipo: 'respuesta', vector: angulo(270) },
  ],
};
const calibracion = (cambios: Record<string, unknown> = {}) =>
  Calibracion.parse({
    formato: 1,
    regla: VERSION_REGLA_DECISION,
    banco_sha256: BANCO.sha256,
    evaluacion_sha256: 'b'.repeat(64),
    proveedor: 'vertex',
    modelo: 'modelo-prueba',
    dimension: 2,
    umbral_fijo: 0.8,
    umbral_derivacion: 0.7,
    margen: 0.1,
    valido: true,
    motivos_invalidez: [],
    control: { total: 100, confusiones: 0, falsos_positivos: 0 },
    medido: '2026-11-04',
    ...cambios,
  });
const contexto = (cambios: Record<string, unknown> = {}): ContextoSemantico => ({ indice: INDICE_SEMANTICO, calibracion: calibracion(cambios) });
const vec = (grados: number): ConsultaSemantica => ({ estado: 'ok', vector: angulo(grados) });
const ir = (texto: string, consulta: ConsultaSemantica | null, ctx: ContextoSemantico | null = contexto(), config = ON) =>
  enrutarConSemantica(texto, INDICE, config, SIN_ATENCION, ctx, consulta);

describe('la coincidencia exacta va primero', () => {
  it('una pregunta exacta decide H2 aunque el vector apunte a otra entrada', () => {
    const r = ir('pregunta sintetica de precio uno', vec(180));
    expect(r.via).toBe('exacta');
    expect(r.similitud).toBeNull();
    expect(r.decision).toEqual(enrutar('pregunta sintetica de precio uno', INDICE, ON, SIN_ATENCION));
    expect(r.decision).toMatchObject({ carril: 'fijo', entradaId: 'ejemplo-precio-1' });
  });

  it('un término de emergencia gana a la semántica', () => {
    const r = ir('termino emergencia ejemplo', vec(0));
    expect(r.decision).toMatchObject({ carril: 'derivacion', motivo: 'emergencia', origen: 'termino_emergencia' });
    expect(r.via).toBe('exacta');
  });

  it('igualdad con el enrutador apagado: nada cambia, sin importar la semántica', () => {
    const apagado = { activo: false, carrilFijo: false };
    for (const t of ['termino emergencia ejemplo', 'pregunta sintetica de precio uno', OTRO, '   ']) {
      const r = ir(t, vec(0), contexto(), apagado);
      expect(r.decision).toEqual(enrutar(t, INDICE, apagado, SIN_ATENCION));
      expect(r.decision).toEqual({ carril: 'ia', motivo: expect.stringMatching(/^enrutador_apagado$/), entradaCandidata: null });
      expect(r.via).toBe('exacta');
      expect(r.similitud).toBeNull();
    }
  });

  it('sin contenido y carril fijo apagado con coincidencia exacta tampoco pasan a la semántica', () => {
    expect(ir('   ', vec(0)).decision).toMatchObject({ carril: 'ia', motivo: 'sin_contenido' });
    const r = ir('pregunta sintetica de precio uno', vec(0), contexto(), { activo: true, carrilFijo: false });
    expect(r).toMatchObject({ via: 'exacta', decision: { motivo: 'carril_fijo_apagado', entradaCandidata: 'ejemplo-precio-1' } });
  });
});

describe('vía semántica', () => {
  it('respuesta fija por similitud, con la similitud redondeada a milésimas', () => {
    const r = ir(OTRO, vec(10));
    expect(r.via).toBe('semantica');
    expect(r.decision).toEqual({ carril: 'fijo', entradaId: 'ejemplo-precio-1', tema: 'precio_plan', riesgo: 'normal' });
    expect(r.similitud).toBe(0.985);
  });

  it('derivación por similitud con el origen pregunta_semantica', () => {
    const r = ir(OTRO, vec(175));
    expect(r.decision).toEqual({ carril: 'derivacion', motivo: 'siniestro_particular', origen: 'pregunta_semantica', entradaId: 'ejemplo-siniestro' });
    expect(r.via).toBe('semantica');
  });

  it('una derivación semántica no necesita carril fijo encendido (D1)', () => {
    expect(ir(OTRO, vec(175), contexto(), { activo: true, carrilFijo: false }).decision).toMatchObject({ carril: 'derivacion', origen: 'pregunta_semantica' });
  });

  it('nada se parece lo bastante: IA con sin_coincidencia', () => {
    const r = ir(OTRO, vec(45));
    expect(r.decision).toEqual({ carril: 'ia', motivo: 'sin_coincidencia', entradaCandidata: null });
    expect(r.via).toBe('semantica');
    expect(r.similitud).toBeNull();
  });

  it('carril fijo apagado con candidata semántica: IA con la candidata', () => {
    const r = ir(OTRO, vec(10), contexto(), { activo: true, carrilFijo: false });
    expect(r.decision).toEqual({ carril: 'ia', motivo: 'carril_fijo_apagado', entradaCandidata: 'ejemplo-precio-1' });
    expect(r.via).toBe('semantica');
  });

  it('una respuesta con contenido pendiente deriva también por la vía semántica', () => {
    expect(ir(OTRO, vec(270)).decision).toEqual({ carril: 'derivacion', motivo: 'contenido_pendiente', origen: 'condicion_entrada', entradaId: 'ejemplo-pendiente' });
  });

  it('D4 con estados coherentes: una confusión en el control invalida la calibración y todo va a la IA', () => {
    const conConfusion = contexto({ valido: false, motivos_invalidez: ['confusion_en_control'], control: { total: 100, confusiones: 1, falsos_positivos: 0 } });
    for (const grados of [10, 175]) expect(ir(OTRO, vec(grados), conConfusion).decision).toEqual({ carril: 'ia', motivo: 'calibracion_no_apta', entradaCandidata: null });
  });

  it('defensa en profundidad: un objeto con estado imposible (sin pasar por el esquema) bloquea el fijo y deja la derivación', () => {
    const imposible: ContextoSemantico = { indice: INDICE_SEMANTICO, calibracion: { ...calibracion(), control: { total: 100, confusiones: 1, falsos_positivos: 0 } } };
    expect(ir(OTRO, vec(10), imposible).decision).toEqual({ carril: 'ia', motivo: 'calibracion_no_apta', entradaCandidata: 'ejemplo-precio-1' });
    expect(ir(OTRO, vec(175), imposible).decision).toMatchObject({ carril: 'derivacion', origen: 'pregunta_semantica' });
  });
});

describe('calibración no apta', () => {
  it.each([
    ['otro SHA del banco', { banco_sha256: 'c'.repeat(64) }],
    ['otro modelo', { modelo: 'otro' }],
    ['otra dimensión', { dimension: 3 }],
    ['valido: false', { valido: false, motivos_invalidez: ['minimos_insuficientes'] }],
    ['otra versión de la regla', { regla: VERSION_REGLA_DECISION + 1 }],
    ['proveedor simulado', { proveedor: 'simulado' }],
  ])('%s: ni respuestas ni derivaciones semánticas; va a la IA', (_n, cambios) => {
    for (const grados of [10, 175]) {
      const r = ir(OTRO, vec(grados), contexto(cambios));
      expect(r.decision).toEqual({ carril: 'ia', motivo: 'calibracion_no_apta', entradaCandidata: null });
      expect(r.similitud).toBeNull();
    }
  });

  it('el proveedor simulado se admite solo con la opción de pruebas', () => {
    const ctx = { ...contexto({ proveedor: 'simulado' }), admitirSimulado: true };
    expect(ir(OTRO, vec(10), ctx).decision).toMatchObject({ carril: 'fijo' });
  });

  it('la derivación exacta no necesita calibración', () => {
    expect(ir('pregunta sintetica de siniestro uno', null, contexto({ valido: false, motivos_invalidez: ['minimos_insuficientes'] })).decision).toMatchObject({ carril: 'derivacion', origen: 'pregunta_derivacion' });
  });
});

describe('D5 ampliada: un crítico sin respaldo de D4 deriva, nunca va a la IA', () => {
  const bancoCritico = cargarBanco(
    JSON.stringify({
      formato: 1,
      version: '1.0.0',
      respuestas: [
        { id: 'r-critica', tema: 'tema_uno', preguntas: ['pregunta critica'], plantilla: 'Texto uno.', aprobado_por: 'Rol Comercial', riesgo: 'critico' },
        { id: 'r-normal', tema: 'tema_dos', preguntas: ['pregunta normal'], plantilla: 'Texto dos.', aprobado_por: 'Rol Comercial', riesgo: 'normal' },
      ],
    }),
  );
  const indiceCritico = prepararEnrutador(bancoCritico.banco, bancoCritico.sha256);
  const semantico: IndiceSemantico = {
    modelo: 'modelo-prueba',
    dimension: 2,
    vectores: [
      { entradaId: 'r-critica', tipo: 'respuesta', vector: angulo(0) },
      { entradaId: 'r-normal', tipo: 'respuesta', vector: angulo(90) },
    ],
  };
  // Estado imposible a propósito (no pasó por el esquema): D4 no respalda el texto fijo.
  const sinD4: ContextoSemantico = {
    indice: semantico,
    calibracion: { ...calibracion({ banco_sha256: bancoCritico.sha256 }), control: { total: 100, confusiones: 1, falsos_positivos: 0 } },
  };
  const con = (grados: number, config = ON, ctx = sinD4) => enrutarConSemantica(OTRO, indiceCritico, config, SIN_ATENCION, ctx, vec(grados));

  it('crítico propuesto con !fijoApto: deriva con contenido_pendiente', () => {
    expect(con(5).decision).toEqual({ carril: 'derivacion', motivo: 'contenido_pendiente', origen: 'pregunta_semantica', entradaId: 'r-critica' });
  });

  it('normal propuesto con !fijoApto: cae a la IA con la candidata', () => {
    expect(con(85).decision).toEqual({ carril: 'ia', motivo: 'calibracion_no_apta', entradaCandidata: 'r-normal' });
  });

  it('excepción a D1: con el carril fijo apagado el crítico deriva y el normal va a la IA con su candidata', () => {
    const apagado = { activo: true, carrilFijo: false };
    expect(con(5, apagado).decision).toEqual({ carril: 'derivacion', motivo: 'contenido_pendiente', origen: 'condicion_entrada', entradaId: 'r-critica' });
    expect(con(85, apagado).decision).toEqual({ carril: 'ia', motivo: 'carril_fijo_apagado', entradaCandidata: 'r-normal' });
    // También por la vía exacta del mismo banco.
    expect(enrutarConSemantica('pregunta critica', indiceCritico, apagado, SIN_ATENCION, null, null)).toMatchObject({
      via: 'exacta',
      decision: { carril: 'derivacion', motivo: 'contenido_pendiente', entradaId: 'r-critica' },
    });
  });

  it('con el enrutador APAGADO del todo la excepción no aplica: todo va a la IA, también el crítico', () => {
    const apagado = { activo: false, carrilFijo: false };
    for (const t of ['pregunta critica', 'pregunta normal', OTRO]) {
      expect(enrutarConSemantica(t, indiceCritico, apagado, SIN_ATENCION, sinD4, vec(5))).toEqual({
        decision: { carril: 'ia', motivo: 'enrutador_apagado', entradaCandidata: null },
        via: 'exacta',
        similitud: null,
      });
    }
  });

  it('con D4 respaldado, el crítico responde fijo', () => {
    const ok: ContextoSemantico = { indice: semantico, calibracion: calibracion({ banco_sha256: bancoCritico.sha256 }) };
    expect(con(5, ON, ok).decision).toMatchObject({ carril: 'fijo', entradaId: 'r-critica', riesgo: 'critico' });
  });
});

describe('fallos de la consulta: siempre a la IA con un motivo enumerado', () => {
  it('sin semántica configurada o sin consulta', () => {
    expect(ir(OTRO, vec(10), null).decision).toEqual({ carril: 'ia', motivo: 'semantica_no_disponible', entradaCandidata: null });
    expect(ir(OTRO, null).decision).toEqual({ carril: 'ia', motivo: 'semantica_no_disponible', entradaCandidata: null });
  });

  it('un índice enrutador sin SHA-256 del banco no usa la semántica', () => {
    const sinSha = prepararEnrutador(BANCO.banco);
    expect(enrutarConSemantica(OTRO, sinSha, ON, SIN_ATENCION, contexto(), vec(10)).decision).toEqual({
      carril: 'ia',
      motivo: 'semantica_no_disponible',
      entradaCandidata: null,
    });
  });

  it('un índice enrutador con otro SHA-256 que la calibración no es apto', () => {
    const otro = prepararEnrutador(BANCO.banco, 'd'.repeat(64));
    expect(enrutarConSemantica(OTRO, otro, ON, SIN_ATENCION, contexto(), vec(10)).decision).toMatchObject({ carril: 'ia', motivo: 'calibracion_no_apta' });
  });

  it('un entradaId del índice semántico que no existe en el banco (o con otro tipo) no se ignora en silencio', () => {
    const huerfano: IndiceSemantico = { ...INDICE_SEMANTICO, vectores: [...INDICE_SEMANTICO.vectores, { entradaId: 'no-existe', tipo: 'respuesta', vector: angulo(45) }] };
    const tipoCambiado: IndiceSemantico = { ...INDICE_SEMANTICO, vectores: [{ entradaId: 'ejemplo-siniestro', tipo: 'respuesta', vector: angulo(180) }] };
    for (const indice of [huerfano, tipoCambiado]) {
      const r = ir(OTRO, vec(10), { indice, calibracion: calibracion() });
      expect(r.decision).toEqual({ carril: 'ia', motivo: 'semantica_no_disponible', entradaCandidata: null });
    }
  });

  it('componentes enormes (> 1e154): se escalan; el puntaje real (0,77) no alcanza 0,99 y nunca sale una respuesta fija', () => {
    const enorme: IndiceSemantico = { modelo: 'modelo-prueba', dimension: 2, vectores: [{ entradaId: 'ejemplo-precio-1', tipo: 'respuesta', vector: [1e200, 1e199] }] };
    const ctx: ContextoSemantico = { indice: enorme, calibracion: calibracion({ umbral_fijo: 0.99, margen: 0.5 }) };
    const r = ir(OTRO, { estado: 'ok', vector: [1e200, 1e200] }, ctx);
    expect(r.decision).toEqual({ carril: 'ia', motivo: 'sin_coincidencia', entradaCandidata: null });
    expect(r.similitud).toBeNull();
    // Un componente no finito sí es un error del embebedor.
    expect(ir(OTRO, { estado: 'ok', vector: [Number.NaN, 1] }, ctx).decision).toMatchObject({ motivo: 'embebedor_error' });
  });

  it('error del embebedor y tiempo agotado', () => {
    expect(ir(OTRO, { estado: 'error' }).decision).toMatchObject({ carril: 'ia', motivo: 'embebedor_error' });
    expect(ir(OTRO, { estado: 'tiempo' }).decision).toMatchObject({ carril: 'ia', motivo: 'embebedor_tiempo' });
  });

  it('un vector de otra dimensión, vacío o con valores no finitos', () => {
    for (const vector of [[1, 0, 0], [1], [], [Number.NaN, 1], [Number.POSITIVE_INFINITY, 0]]) {
      const r = ir(OTRO, { estado: 'ok', vector });
      expect(r.decision).toEqual({ carril: 'ia', motivo: 'embebedor_error', entradaCandidata: null });
      expect(r.via).toBe('semantica');
    }
  });
});

describe('bitácora del enrutador', () => {
  const base = { agenteId: 'agente', perfilId: null, conversacionHash: 'hash', canal: 'web' };

  it('el evento lleva carril, vía, similitud, motivo y latencia, y ningún texto', () => {
    const TEXTO = 'FRASE-UNICA-QUE-NO-DEBE-APARECER';
    const bitacora = new BitacoraEnMemoria();
    for (const consulta of [vec(10), vec(175), vec(45), { estado: 'tiempo' } as const]) {
      bitacora.registrar(eventoEnrutador(ir(TEXTO, consulta), base, 12.6));
    }
    bitacora.registrar(eventoEnrutador(ir('termino emergencia ejemplo', null), base, 0.2));
    for (const rara of [Number.NaN, Number.POSITIVE_INFINITY, -5]) expect(eventoEnrutador(ir(TEXTO, vec(10)), base, rara).latenciaMs).toBe(0);
    expect(JSON.stringify(bitacora.eventos)).not.toContain('FRASE-UNICA');
    expect(JSON.stringify(bitacora.eventos)).not.toContain('termino emergencia');
    expect(bitacora.eventos[0]).toMatchObject({ tipo: 'enrutador', carril: 'fijo', via: 'semantica', similitud: 0.985, latenciaMs: 13 });
    expect(bitacora.eventos[0]).not.toHaveProperty('motivo');
    expect(bitacora.eventos[1]).toMatchObject({ carril: 'derivacion', motivo: 'siniestro_particular' });
    expect(bitacora.eventos[2]).toMatchObject({ carril: 'ia', motivo: 'sin_coincidencia', via: 'semantica' });
    expect(bitacora.eventos[3]).toMatchObject({ carril: 'ia', motivo: 'embebedor_tiempo' });
    expect(bitacora.eventos[4]).toMatchObject({ carril: 'derivacion', via: 'exacta', motivo: 'emergencia', latenciaMs: 0 });
    expect(bitacora.eventos[4]).not.toHaveProperty('similitud');
    expect(bitacora.eventos[0]?.avisos).toEqual(['carril:fijo', 'respuesta_fija:ejemplo-precio-1', 'riesgo:normal']);
  });
});

describe('estructura', () => {
  it('el archivo no usa red, entorno, expresiones construidas, fecha ni azar', () => {
    const fuente = readFileSync(new URL('./enrutador-semantico.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Date', 'Math.random', 'setTimeout']) expect(fuente).not.toContain(prohibido);
  });
});
