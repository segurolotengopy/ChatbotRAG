import { describe, expect, it } from 'vitest';
import { validarConfiguracion } from '../configuracion/cargar.js';
import type { FragmentoRecuperado } from '../puertos/indice-conocimiento.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { armarPrompt } from './armar.js';

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
