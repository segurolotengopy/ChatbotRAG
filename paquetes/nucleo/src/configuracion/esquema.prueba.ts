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
