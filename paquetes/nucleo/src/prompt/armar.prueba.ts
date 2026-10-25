import { describe, expect, it } from 'vitest';
import { validarConfiguracion } from '../configuracion/cargar.js';
import type { FragmentoRecuperado } from '../puertos/indice-conocimiento.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { armarPrompt } from './armar.js';
import { frasePantallaActual } from './frases.js';

const fragmento: FragmentoRecuperado = {
  id: 'f1',
  fuenteId: 'paso',
  fuenteTitulo: 'Paso 2 · Verifique su número',
  fuenteVersion: 'v1',
  coleccion: 'x',
  texto: 'Ingrese su número de WhatsApp.',
  orden: 0,
  puntaje: 0.9,
};

function prompt(uso?: 'citar' | 'parafrasear', fragmentos: FragmentoRecuperado[] = [fragmento]): string {
  const config = validarConfiguracion({
    ...CONFIG_PRUEBA,
    conocimiento: { ...CONFIG_PRUEBA.conocimiento, ...(uso ? { usoDelRespaldo: uso } : {}) },
  });
  return armarPrompt({ config, ahora: new Date('2026-10-12T14:00:00Z'), fragmentos, orientacion: { facetas: {} }, canal: 'web' });
}

describe('uso del respaldo documental', () => {
  it('por omisión conserva el prompt de siempre: sin frase de uso', () => {
    expect(prompt()).not.toContain('USO DEL RESPALDO');
    expect(prompt('citar')).toBe(prompt());
  });

  it('parafrasear antepone la frase fija al bloque de respaldo, fuera de los delimitadores', () => {
    const p = prompt('parafrasear');
    const frase = p.indexOf('USO DEL RESPALDO');
    expect(frase).toBeGreaterThan(-1);
    expect(frase).toBeLessThan(p.indexOf('INICIO DE RESPALDO DOCUMENTAL'));
  });

  it('sin fragmentos no agrega la frase', () => {
    expect(prompt('parafrasear', [])).not.toContain('USO DEL RESPALDO');
  });

  it('rechaza valores fuera del enumerado', () => {
    expect(() => prompt('lo-que-sea' as never)).toThrow();
  });
});

describe('uso del respaldo y perfiles', () => {
  function promptDePerfil(base: 'citar' | 'parafrasear', perfil: Record<string, unknown>): string {
    const config = validarConfiguracion({
      ...CONFIG_PRUEBA,
      conocimiento: { ...CONFIG_PRUEBA.conocimiento, usoDelRespaldo: base },
      perfiles: { PERFIL: { nombre: 'Perfil de prueba', ...perfil } },
    });
    return armarPrompt({ config: resolverConfiguracion(config, 'PERFIL'), ahora: new Date('2026-10-12T14:00:00Z'), fragmentos: [fragmento], orientacion: { facetas: {} }, canal: 'web' });
  }

  it('un perfil que no lo menciona hereda parafrasear de la base', () => {
    expect(promptDePerfil('parafrasear', { conocimiento: { umbral: 0.5 } })).toContain('USO DEL RESPALDO');
  });

  it('un perfil con citar anula a la base', () => {
    expect(promptDePerfil('parafrasear', { conocimiento: { usoDelRespaldo: 'citar' } })).not.toContain('USO DEL RESPALDO');
  });

  it('un perfil con parafrasear lo activa aunque la base use citar', () => {
    expect(promptDePerfil('citar', { conocimiento: { usoDelRespaldo: 'parafrasear' } })).toContain('USO DEL RESPALDO');
  });
});

describe('modo de contacto humano', () => {
  function promptConModo(modo?: 'traspaso' | 'canal'): string {
    const config = validarConfiguracion({
      ...CONFIG_PRUEBA,
      operacion: { ...CONFIG_PRUEBA.operacion, contactoHumano: { ...CONFIG_PRUEBA.operacion?.contactoHumano, ...(modo ? { modo } : {}) } },
    });
    return armarPrompt({ config, ahora: new Date('2026-10-18T14:00:00Z'), fragmentos: [fragmento], orientacion: { facetas: {} }, canal: 'web' });
  }

  it('por omisión no agrega nada: el prompt de siempre', () => {
    expect(promptConModo()).not.toContain('CONTACTO CON UNA PERSONA');
    expect(promptConModo('traspaso')).toBe(promptConModo());
  });

  it('«canal» prohíbe prometer traspaso y manda indicar el canal, dentro de ALCANCE y fuera de los datos', () => {
    const p = promptConModo('canal');
    const i = p.indexOf('CONTACTO CON UNA PERSONA');
    expect(i).toBeGreaterThan(p.indexOf('ALCANCE'));
    expect(i).toBeLessThan(p.indexOf('INICIO DE DATOS'));
    expect(p).toContain('NO existe ningún traspaso');
  });

  it('rechaza valores fuera del enumerado', () => {
    expect(() => promptConModo('transferir' as never)).toThrow();
  });
});

describe('pantalla actual (contexto de página)', () => {
  const segundo: FragmentoRecuperado = { ...fragmento, id: 'f2', texto: 'Pulse Continuar.' };
  function conPagina(n: number | undefined, uso?: 'parafrasear'): string {
    const config = validarConfiguracion({ ...CONFIG_PRUEBA, conocimiento: { ...CONFIG_PRUEBA.conocimiento, ...(uso ? { usoDelRespaldo: uso } : {}) } });
    return armarPrompt({ config, ahora: new Date('2026-10-12T14:00:00Z'), fragmentos: [fragmento, segundo], orientacion: { facetas: {} }, canal: 'web', ...(n === undefined ? {} : { fragmentosPagina: n }) });
  }

  it('sin fragmentosPagina (o con 0) el prompt no cambia', () => {
    expect(conPagina(undefined)).not.toContain('PANTALLA ACTUAL');
    expect(conPagina(0)).toBe(conPagina(undefined));
  });

  it('con 1 dice «el documento [1]» y con 2 «los documentos [1] a [2]»', () => {
    expect(conPagina(1)).toContain('describen el documento [1] del RESPALDO DOCUMENTAL');
    expect(conPagina(2)).toContain('describen los documentos [1] a [2] del RESPALDO DOCUMENTAL');
    expect(frasePantallaActual(3)).toContain('[1] a [3]');
  });

  it('la frase va antes de la de uso y fuera de los delimitadores, y el formato del respaldo no cambia', () => {
    const p = conPagina(1, 'parafrasear');
    expect(p.indexOf('PANTALLA ACTUAL')).toBeLessThan(p.indexOf('USO DEL RESPALDO'));
    expect(p.indexOf('USO DEL RESPALDO')).toBeLessThan(p.indexOf('INICIO DE RESPALDO DOCUMENTAL'));
    expect(p).toContain('[1] Documento: «Paso 2 · Verifique su número» (versión v1)\nIngrese su número de WhatsApp.');
    expect(p).toContain('[2] Documento: «Paso 2 · Verifique su número» (versión v1)\nPulse Continuar.');
  });
});
