/**
 * Pruebas del perfil del conocimiento en el entorno: falla cerrado hacia `produccion`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorEntorno, leerEntorno } from './entorno.js';

const CLIENTES = JSON.stringify([{ id: 'c1', agenteId: 'agente-uno', claveSha256: createHash('sha256').update('x').digest('hex') }]);
const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CHATBOTRAG_CLIENTES: CLIENTES, ...extra });

describe('perfil del conocimiento', () => {
  it('sin la variable el perfil es produccion', () => {
    expect(leerEntorno(base()).perfilConocimiento).toBe('produccion');
  });

  it('pruebas con bucket y versión es válido', () => {
    const e = leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' }));
    expect(e.perfilConocimiento).toBe('pruebas');
  });

  it('pruebas sin bucket o sin versión es un error de entorno', () => {
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas' }))).toThrow(ErrorEntorno);
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico' }))).toThrow(ErrorEntorno);
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' }))).toThrow(ErrorEntorno);
  });

  it('produccion con bucket o versión es un error de entorno', () => {
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'produccion', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico' }))).toThrow(ErrorEntorno);
    expect(() => leerEntorno(base({ CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' }))).toThrow(ErrorEntorno);
  });

  it('ausente o vacío es produccion; un valor no vacío e inválido es un error de entorno', () => {
    expect(leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: '' })).perfilConocimiento).toBe('produccion');
    expect(leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'produccion' })).perfilConocimiento).toBe('produccion');
    for (const valor of ['PRUEBAS', 'staging', 'Pruebas ']) {
      expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: valor }))).toThrow(ErrorEntorno);
    }
  });

  it('APP_ENV=production veda el perfil pruebas y el bucket del paquete', () => {
    const p = { CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' };
    expect(() => leerEntorno(base({ ...p, APP_ENV: 'production' }))).toThrow(/APP_ENV=production/);
    expect(() => leerEntorno(base({ CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', APP_ENV: 'production' }))).toThrow(ErrorEntorno);
    expect(leerEntorno(base({ APP_ENV: 'production' })).perfilConocimiento).toBe('produccion');
    expect(leerEntorno(base({ ...p, APP_ENV: 'staging' })).perfilConocimiento).toBe('pruebas');
  });

  it('rechaza un nombre de bucket o una versión con forma inválida', () => {
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'GS://x', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' }))).toThrow(ErrorEntorno);
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: 'v1' }))).toThrow(ErrorEntorno);
  });
});
