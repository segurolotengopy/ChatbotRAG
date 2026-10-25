/**
 * PRUEBA DE `modelo.razonamiento` EN LA CARGA
 *
 * Gemini 2.5 Pro no admite `thinkingBudget: 0`: con `desactivado` el servicio rechazaría cada petición.
 * La carga lo rechaza antes. Qué NO garantiza: solo reconoce `pro` como palabra del nombre del modelo.
 */
import { describe, expect, it } from 'vitest';
import { ErrorConfiguracion, validarConfiguracion } from './cargar.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';

const con = (nombre: string, razonamiento?: 'automatico' | 'desactivado') =>
  validarConfiguracion({ ...CONFIG_PRUEBA, modelo: { ...CONFIG_PRUEBA.modelo, nombre, ...(razonamiento ? { razonamiento } : {}) } });

describe('modelo.razonamiento desactivado', () => {
  it('se rechaza con un modelo Pro, con el nombre real en el hallazgo', () => {
    for (const nombre of ['gemini-2.5-pro', 'gemini-2.5-pro-preview', 'models/gemini-pro']) {
      expect(() => con(nombre, 'desactivado')).toThrow(ErrorConfiguracion);
      try {
        con(nombre, 'desactivado');
      } catch (e) {
        expect((e as ErrorConfiguracion).detalles.join(' ')).toContain(`El modelo ${nombre} no admite razonamiento desactivado`);
      }
    }
  });

  it('se acepta con Flash y Flash-Lite, y con Pro en automático', () => {
    expect(con('gemini-2.5-flash', 'desactivado').modelo.razonamiento).toBe('desactivado');
    expect(con('gemini-2.5-flash-lite', 'desactivado').modelo.razonamiento).toBe('desactivado');
    expect(con('gemini-2.5-pro', 'automatico').modelo.razonamiento).toBe('automatico');
    expect(con('gemini-2.5-pro').modelo.razonamiento).toBe('automatico');
  });
});
