/** Pruebas del enrutador determinista. Datos sintéticos. */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { cargarBanco } from './cargar.js';
import { CARRILES, MOTIVOS_IA, ORIGENES_DERIVACION, avisosDecision, enrutar, prepararEnrutador } from './enrutador.js';
import type { DecisionEnrutador, EstadoEnrutador } from './enrutador.js';
import type { BancoRespuestas } from './esquema.js';

const EJEMPLO = readFileSync(new URL('./banco-ejemplo.json', import.meta.url), 'utf8');
const BASE = cargarBanco(EJEMPLO, { admitirSintetico: true }).banco;
const INDICE = prepararEnrutador(BASE);
const ON = { activo: true, carrilFijo: true };
const SIN_ATENCION: EstadoEnrutador = { atencionHumanaSolicitada: false };
const ir = (texto: string, config = ON, estado = SIN_ATENCION): DecisionEnrutador => enrutar(texto, INDICE, config, estado);

const respuesta = (cambios: Record<string, unknown> = {}) => ({
  id: 'r-uno',
  tema: 'tema_uno',
  preguntas: ['pregunta uno'],
  plantilla: 'Texto uno.',
  aprobado_por: 'Rol Comercial',
  riesgo: 'normal',
  ...cambios,
});
const enLinea = (cambios: Record<string, unknown>): BancoRespuestas =>
  cargarBanco(JSON.stringify({ formato: 1, version: '1.0.0', respuestas: [respuesta()], ...cambios })).banco;

describe('enrutador', () => {
  it('las listas enumeradas son las acordadas', () => {
    expect(CARRILES).toEqual(['fijo', 'derivacion', 'ia']);
    expect(MOTIVOS_IA).toEqual(['enrutador_apagado', 'sin_contenido', 'sin_coincidencia', 'carril_fijo_apagado']);
    expect(ORIGENES_DERIVACION).toEqual(['termino_emergencia', 'pregunta_derivacion', 'condicion_entrada']);
  });

  it('apagado: todo va a la IA', () => {
    for (const t of ['termino emergencia ejemplo', 'pregunta sintetica de precio uno']) {
      expect(ir(t, { activo: false, carrilFijo: false })).toEqual({ carril: 'ia', motivo: 'enrutador_apagado', entradaCandidata: null });
    }
  });

  it('un término de emergencia con puntuación pegada deriva', () => {
    expect(ir('hola,termino,emergencia.ejemplo')).toEqual({
      carril: 'derivacion',
      motivo: 'emergencia',
      origen: 'termino_emergencia',
      entradaId: 'ejemplo-emergencia',
    });
  });

  it('el término respeta el límite de palabra', () => {
    expect(ir('terminos emergencia ejemplo')).toMatchObject({ carril: 'ia', motivo: 'sin_coincidencia' });
    expect(ir('xtermino emergencia ejemploz')).toMatchObject({ carril: 'ia', motivo: 'sin_coincidencia' });
  });

  it.each([
    ['invisibles', 'ter­mi​no emergencia ejemplo'],
    ['BIDI', '‮Termino‬ emergencia ejemplo'],
    ['ancho completo', 'ｔｅｒｍｉｎｏ emergencia ejemplo'],
    ['marca combinante', 'término emergencia ejemplo'],
  ])('un término con %s dentro se reconoce', (_n, texto) => {
    expect(ir(texto)).toMatchObject({ carril: 'derivacion', origen: 'termino_emergencia' });
  });

  it('límite conocido y documentado: un homóglifo cirílico evita el término', () => {
    expect(ir('tеrmino emergencia ejemplo')).toMatchObject({ carril: 'ia', motivo: 'sin_coincidencia' });
  });

  it('una pregunta de derivación deriva, también con el carril fijo apagado', () => {
    for (const config of [ON, { activo: true, carrilFijo: false }]) {
      expect(ir('¿Pregunta sintetica de siniestro uno?', config)).toEqual({
        carril: 'derivacion',
        motivo: 'siniestro_particular',
        origen: 'pregunta_derivacion',
        entradaId: 'ejemplo-siniestro',
      });
    }
  });

  it('con el carril fijo apagado la pregunta conocida va a la IA con su candidata', () => {
    expect(ir('pregunta sintetica de precio uno', { activo: true, carrilFijo: false })).toEqual({
      carril: 'ia',
      motivo: 'carril_fijo_apagado',
      entradaCandidata: 'ejemplo-precio-1',
    });
  });

  it('con el carril fijo encendido responde fijo, también con invisibles dentro', () => {
    const esperado = { carril: 'fijo', entradaId: 'ejemplo-precio-1', tema: 'precio_plan', riesgo: 'normal' };
    expect(ir('Pregunta sintetica de precio uno')).toEqual(esperado);
    expect(ir('pregunta sin​tetica de precio uno')).toEqual(esperado);
  });

  it('una entrada con contenido_pendiente deriva', () => {
    expect(ir('pregunta sintetica de tema pendiente')).toEqual({
      carril: 'derivacion',
      motivo: 'contenido_pendiente',
      origen: 'condicion_entrada',
      entradaId: 'ejemplo-pendiente',
    });
  });

  it('atencion_humana_solicitada deriva solo si ya se pidió', () => {
    const banco = enLinea({ respuestas: [respuesta({ derivar_cuando: ['atencion_humana_solicitada'] })] });
    const indice = prepararEnrutador(banco);
    expect(enrutar('pregunta uno', indice, ON, { atencionHumanaSolicitada: true })).toEqual({
      carril: 'derivacion',
      motivo: 'atencion_humana_ya_solicitada',
      origen: 'condicion_entrada',
      entradaId: 'r-uno',
    });
    expect(enrutar('pregunta uno', indice, ON, { atencionHumanaSolicitada: false })).toMatchObject({ carril: 'fijo', entradaId: 'r-uno' });
  });

  it('precedencia: una pregunta de respuesta idéntica a un término de emergencia gana la derivación', () => {
    const banco = enLinea({
      respuestas: [respuesta({ preguntas: ['termino de emergencia'] })],
      derivaciones: [{ id: 'd-uno', motivo: 'emergencia', terminos: ['termino de emergencia'], texto: 'Texto real.', aprobado_por: 'Rol Comercial' }],
    });
    expect(enrutar('Termino de emergencia', prepararEnrutador(banco), ON, SIN_ATENCION)).toMatchObject({ carril: 'derivacion', origen: 'termino_emergencia' });
  });

  it('no hay coincidencia parcial', () => {
    for (const t of ['pregunta sintetica de precio', 'pregunta sintetica de precio uno y algo más', 'precio']) {
      expect(ir(t)).toMatchObject({ carril: 'ia', motivo: 'sin_coincidencia' });
    }
  });

  it('sin contenido va a la IA', () => {
    for (const t of ['', '   ', '​​', '¿?!…']) expect(ir(t)).toEqual({ carril: 'ia', motivo: 'sin_contenido', entradaCandidata: null });
  });

  it('es determinista y no muta el banco', () => {
    const copia = JSON.stringify(BASE);
    const primera = ir('pregunta sintetica de precio uno');
    for (let i = 0; i < 100; i++) expect(ir('pregunta sintetica de precio uno')).toEqual(primera);
    expect(JSON.stringify(BASE)).toBe(copia);
  });

  it('si una pregunta se repite entre entradas conserva la primera', () => {
    const banco = { ...BASE, respuestas: [...BASE.respuestas, { ...BASE.respuestas[0]!, id: 'ejemplo-copia' }] };
    expect(enrutar('pregunta sintetica de precio uno', prepararEnrutador(banco), ON, SIN_ATENCION)).toMatchObject({ entradaId: 'ejemplo-precio-1' });
  });
});

describe('confidencialidad de la decisión', () => {
  const PERSONA = 'MiTextoUnicoXyz123 termino emergencia ejemplo 4111111111111111';
  const FORMA = /^(carril|respuesta_fija|riesgo|derivacion|origen|entrada|motivo_ia|candidata):[a-z0-9_.-]+$/i;
  const entradas = [PERSONA, 'pregunta sintetica de precio uno', 'MiTextoUnicoXyz123 sin nada conocido'];

  it('el texto de la persona no aparece en la decisión, en los avisos ni en la bitácora', () => {
    const carriles = new Set<string>();
    for (const t of entradas) {
      const d = ir(t);
      carriles.add(d.carril);
      const avisos = avisosDecision(d);
      for (const a of avisos) expect(a).toMatch(FORMA);
      const bitacora = new BitacoraEnMemoria();
      bitacora.registrar({ tipo: 'mensaje_atendido', agenteId: 'a', perfilId: null, conversacionHash: 'h', canal: 'web', avisos });
      const volcado = JSON.stringify(d) + JSON.stringify(bitacora.eventos);
      expect(volcado).not.toContain('MiTextoUnicoXyz123');
      expect(volcado).not.toContain('4111');
    }
    expect([...carriles].sort()).toEqual(['derivacion', 'fijo', 'ia']);
  });

  it('los avisos de cada carril traen lo acordado', () => {
    expect(avisosDecision(ir('pregunta sintetica de precio uno'))).toEqual(['carril:fijo', 'respuesta_fija:ejemplo-precio-1', 'riesgo:normal']);
    expect(avisosDecision(ir('termino emergencia ejemplo'))).toEqual(['carril:derivacion', 'derivacion:emergencia', 'origen:termino_emergencia', 'entrada:ejemplo-emergencia']);
    expect(avisosDecision(ir('algo desconocido'))).toEqual(['carril:ia', 'motivo_ia:sin_coincidencia']);
    expect(avisosDecision(ir('pregunta sintetica de precio uno', { activo: true, carrilFijo: false }))).toEqual([
      'carril:ia',
      'motivo_ia:carril_fijo_apagado',
      'candidata:ejemplo-precio-1',
    ]);
  });
});

describe('tiempo y ReDoS', () => {
  const grande = enLinea({
    respuestas: Array.from({ length: 500 }, (_, i) =>
      respuesta({ id: `r-${i}`, preguntas: Array.from({ length: 30 }, (_, j) => `pregunta numero ${i} variante ${j}`) }),
    ),
    derivaciones: Array.from({ length: 20 }, (_, i) => ({
      id: `d-${i}`,
      motivo: 'emergencia',
      terminos: Array.from({ length: 200 }, (_, j) => `termino numero ${i} item ${j}`),
      texto: 'Texto real.',
      aprobado_por: 'Rol Comercial',
    })),
  });

  it('prepara y enruta un banco grande sin demora', () => {
    const t0 = performance.now();
    const indice = prepararEnrutador(grande);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(indice.terminos).toHaveLength(4000);
    for (const unidad of ['a', 'a ', '​', 'á', '¿', 'a,']) {
      const entrada = unidad.repeat(Math.ceil(50_000 / unidad.length)).slice(0, 50_000);
      const t1 = performance.now();
      enrutar(entrada, indice, ON, SIN_ATENCION);
      expect(performance.now() - t1).toBeLessThan(250);
    }
  });
});

describe('estructura', () => {
  it('el archivo no construye expresiones regulares, no usa red ni entorno, fecha ni azar', () => {
    const fuente = readFileSync(new URL('./enrutador.ts', import.meta.url), 'utf8');
    for (const prohibido of ['RegExp(', 'fetch', 'process.env', 'Date', 'Math.random']) expect(fuente).not.toContain(prohibido);
  });
});
