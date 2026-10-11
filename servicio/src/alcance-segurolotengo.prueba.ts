/**
 * ALCANCE DEL ASISTENTE DE SEGUROLOTENGO
 *
 * El asistente explica el funcionamiento del sitio y los procedimientos; no
 * informa sobre el producto. Esa decisión (2026-10-11) vive en la configuración
 * y se puede deshacer sin querer de tres maneras que una regla de alcance sola
 * no impide:
 *
 *  1. Dejar cargadas las fuentes con coberturas o precios: el modelo las recupera
 *     aunque el alcance las prohíba, y basta un mensaje torcido para que las use.
 *  2. Dejar la herramienta `recomendar_opcion` y sus reglas: devuelve precios y
 *     sumas aseguradas como texto fijo, que el servicio entrega SIN pasar por el
 *     modelo, así que ninguna compuerta de salida lo frena.
 *  3. Reponer en los mensajes fijos la promesa de explicar planes y coberturas.
 *
 * Esta prueba lee la configuración REAL, la que se despliega, y no un ejemplo.
 * Qué NO garantiza: que el modelo respete el alcance ante un mensaje adverso.
 * Eso lo miden las baterías de casos fuera de alcance, no esta prueba.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cargarConfiguracionDesdeJson } from '@chatbotrag/nucleo';

const RUTA = new URL('../../configuraciones/segurolotengo.json', import.meta.url);
const config = cargarConfiguracionDesdeJson(readFileSync(RUTA, 'utf8'));

/** Lo que se busca en las fuentes: el contenido de producto que quedó fuera de alcance. */
const FUENTE_DE_PRODUCTO = /cobertura|exclusion|planes?-|premio|poliza|carencia/i;
/** Un monto en guaraníes: `Gs. 319.000`, `Gs 50.000.000`. */
const MONTO = /Gs\.?\s*\d/;

const perfiles = Object.entries(config.perfiles);

describe('alcance del asistente de SeguroLoTengo: funcionamiento, no producto', () => {
  it('declara cuatro perfiles, los mismos ids que usa el catálogo del portal', () => {
    expect(Object.keys(config.perfiles).sort()).toEqual(['ACCIDENTES_PERSONALES', 'RESPONSABILIDAD_CIVIL', 'VIDA', 'VIDA_ONCOLOGICO']);
  });

  it('ningún perfil carga fuentes de coberturas, exclusiones, planes o premios', () => {
    for (const [id, perfil] of perfiles) {
      for (const f of perfil.conocimiento?.fuentes ?? []) {
        expect(`${id}: ${f.id} ${f.ruta}`, `el perfil ${id} carga la fuente de producto «${f.id}»`).not.toMatch(FUENTE_DE_PRODUCTO);
      }
    }
    for (const f of config.conocimiento.fuentes) {
      expect(`${f.id} ${f.ruta}`, `la configuración global carga la fuente de producto «${f.id}»`).not.toMatch(FUENTE_DE_PRODUCTO);
    }
  });

  it('ningún perfil ofrece la herramienta que recomienda plan', () => {
    for (const [id, perfil] of perfiles) {
      const nombres = (perfil.herramientas ?? []).map((h) => h.nombre);
      expect(nombres, `el perfil ${id} ofrece recomendar_opcion`).not.toContain('recomendar_opcion');
    }
    expect(config.herramientas.map((h) => h.nombre)).not.toContain('recomendar_opcion');
  });

  it('ninguna regla de orientación puede devolver un texto fijo con montos', () => {
    // Las reglas de orientación las entrega el servicio tal cual, sin pasar por
    // el modelo ni por las compuertas de salida: un monto ahí sale directo.
    const todas = [config.orientacion, ...perfiles.map(([, p]) => p.orientacion)];
    for (const o of todas) {
      for (const r of o?.reglas ?? []) {
        expect(r.texto, 'una regla de orientación devuelve un monto').not.toMatch(MONTO);
      }
    }
  });

  it('los mensajes fijos no prometen explicar planes, coberturas ni carencias', () => {
    const fijos = [config.mensajes.bienvenida, config.mensajes.fueraDeAlcance];
    for (const m of fijos) {
      expect(m, 'un mensaje fijo promete lo que ya no se responde').not.toMatch(/planes|coberturas|carencias|exclusiones/i);
    }
  });

  it('declara como bloqueados los temas de producto que se sacaron del alcance', () => {
    const bloqueados = config.alcance.temasBloqueados.join(' | ').toLowerCase();
    expect(bloqueados).toContain('cubre');
    expect(bloqueados).toContain('precios');
  });
});
