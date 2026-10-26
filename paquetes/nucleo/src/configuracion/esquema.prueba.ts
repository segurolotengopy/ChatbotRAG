import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cargarConfiguracionDesdeJson, validarConfiguracion } from './cargar.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';

const RAIZ = fileURLToPath(new URL('../../../../configuraciones/', import.meta.url));

describe('tipoAgente', () => {
  it('es opcional y vale general por omisión', () => {
    expect(validarConfiguracion(CONFIG_PRUEBA).tipoAgente).toBe('general');
  });
  it('acepta kuaa y rechaza cualquier otro valor', () => {
    expect(validarConfiguracion({ ...CONFIG_PRUEBA, tipoAgente: 'kuaa' }).tipoAgente).toBe('kuaa');
    expect(() => validarConfiguracion({ ...CONFIG_PRUEBA, tipoAgente: 'otro' })).toThrow();
  });
  it('las configuraciones de ejemplo validan: SeguroLoTengo y comercio son general, Kuaa es kuaa', () => {
    const tipo = (a: string) => cargarConfiguracionDesdeJson(readFileSync(`${RAIZ}${a}`, 'utf8')).tipoAgente;
    expect(tipo('segurolotengo.json')).toBe('general');
    expect(tipo('comercio-agendamiento.json')).toBe('general');
    expect(tipo('kuaa.json')).toBe('kuaa');
  });
});

function detalles(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    return ((e as { detalles?: string[] }).detalles ?? []).join('; ');
  }
  return '';
}

describe('conocimiento.paquete', () => {
  const conPaquete = (extra: Record<string, unknown>) => ({ ...CONFIG_PRUEBA, conocimiento: { ...CONFIG_PRUEBA.conocimiento, paquete: { habilitado: true } }, ...extra });
  it('por omisión no está habilitado', () => {
    expect(validarConfiguracion(CONFIG_PRUEBA).conocimiento.paquete.habilitado).toBe(false);
  });
  it('un agente general no puede habilitarlo; uno kuaa sí', () => {
    expect(detalles(() => validarConfiguracion(conPaquete({})))).toMatch(/solo se admite con tipoAgente/);
    expect(validarConfiguracion(conPaquete({ tipoAgente: 'kuaa' })).conocimiento.paquete.habilitado).toBe(true);
  });
  it('un perfil no puede definirlo', () => {
    expect(detalles(() => validarConfiguracion({ ...CONFIG_PRUEBA, tipoAgente: 'kuaa', perfiles: { PA: { nombre: 'A', conocimiento: { paquete: { habilitado: true } } } } }))).toMatch(/perfil no puede definir/);
  });
});
