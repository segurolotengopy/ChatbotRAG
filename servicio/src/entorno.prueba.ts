/**
 * Pruebas del perfil del conocimiento en el entorno: falla cerrado hacia `produccion`.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorEntorno, leerEntorno } from './entorno.js';

const CLIENTES = JSON.stringify([{ id: 'c1', agenteId: 'agente-uno', claveSha256: createHash('sha256').update('x').digest('hex') }]);
const AMB = { APP_ENV: 'staging' };
const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ CHATBOTRAG_CLIENTES: CLIENTES, ...extra });

describe('perfil del conocimiento', () => {
  it('sin la variable el perfil es produccion', () => {
    expect(leerEntorno(base()).perfilConocimiento).toBe('produccion');
  });

  it('pruebas con bucket y versión es válido', () => {
    const e = leerEntorno(base({ ...AMB, CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' }));
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

  it('el paquete no validado solo se admite con APP_ENV staging, development o test (normalizado)', () => {
    const p = { CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' };
    for (const ok of ['staging', 'Staging', ' development ', 'TEST']) expect(leerEntorno(base({ ...p, APP_ENV: ok })).perfilConocimiento).toBe('pruebas');
    for (const malo of ['production', 'Production', 'PRODUCTION', 'production ', ' production', 'prod', 'produccion', 'prod-1', 'otro', '']) {
      expect(() => leerEntorno(base({ ...p, APP_ENV: malo }))).toThrow(/APP_ENV/);
      expect(() => leerEntorno(base({ CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', APP_ENV: malo }))).toThrow(ErrorEntorno);
    }
    // Ausente: no se puede distinguir un entorno local con certeza (NODE_ENV vale development por omisión).
    expect(() => leerEntorno(base(p))).toThrow(/APP_ENV/);
    expect(() => leerEntorno(base({ ...p, NODE_ENV: 'development' }))).toThrow(/APP_ENV/);
    // Sin paquete, cualquier APP_ENV es válido y el perfil es produccion.
    expect(leerEntorno(base({ APP_ENV: 'production' })).perfilConocimiento).toBe('produccion');
  });

  it('rechaza un nombre de bucket o una versión con forma inválida', () => {
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'GS://x', CHATBOTRAG_VERSION_PAQUETE: '1.0.0' }))).toThrow(ErrorEntorno);
    expect(() => leerEntorno(base({ CHATBOTRAG_PERFIL_CONOCIMIENTO: 'pruebas', CHATBOTRAG_BUCKET_PAQUETE: 'bucket-sintetico', CHATBOTRAG_VERSION_PAQUETE: 'v1' }))).toThrow(ErrorEntorno);
  });
});

describe('bancos aprobados (H4c)', () => {
  const SHA = 'a'.repeat(64);
  const decl = (extra: Record<string, unknown> = {}) => JSON.stringify({ 'agente-uno': { version: '1.2.3', sha256: SHA, ...extra } });
  const conBucket = (bancos: string) => base({ CHATBOTRAG_BUCKET_BANCO: 'bucket-banco', CHATBOTRAG_BANCOS: bancos });

  it('sin variables no hay bancos', () => {
    expect(leerEntorno(base()).bancos).toEqual({});
  });

  it('declaración válida, con y sin calibración', () => {
    expect(leerEntorno(conBucket(decl())).bancos).toEqual({ 'agente-uno': { version: '1.2.3', sha256: SHA } });
    expect(leerEntorno(conBucket(decl({ sha256Calibracion: 'b'.repeat(64) }))).bancos['agente-uno']?.sha256Calibracion).toBe('b'.repeat(64));
  });

  it('rechaza hex corto, versión no semver, claves extra, JSON roto y agenteId malformado', () => {
    for (const malo of [decl({ sha256: 'abc' }), decl({ version: '1.2' }), decl({ version: 'v1.2.3' }), decl({ version: '01.2.3' }), decl({ sha256Calibracion: 'zz' }), decl({ extra: 1 }), 'no es json', '[]', JSON.stringify({ 'AG': { version: '1.0.0', sha256: SHA } })]) {
      expect(() => leerEntorno(conBucket(malo)), malo).toThrow(ErrorEntorno);
    }
  });

  it('un objeto vacío o solo espacios junto con el bucket es un error claro', () => {
    for (const vacio of ['{}', '   ', '']) {
      expect(() => leerEntorno(conBucket(vacio)), vacio).toThrow(/deben ir juntas y con al menos un agente/);
    }
  });

  it('una clave de agente inválida no se repite en el error', () => {
    try {
      leerEntorno(conBucket(JSON.stringify({ AKIA_SECRETO_PEGADO_123: { version: '1.0.0', sha256: SHA } })));
    } catch (e) {
      expect((e as Error).message).toContain('clave de agente no admitida');
      expect((e as Error).message).not.toContain('AKIA_SECRETO_PEGADO_123');
      return;
    }
    throw new Error('debía fallar');
  });

  it('las dos variables van juntas', () => {
    expect(() => leerEntorno(base({ CHATBOTRAG_BANCOS: decl() }))).toThrow(ErrorEntorno);
    expect(() => leerEntorno(base({ CHATBOTRAG_BUCKET_BANCO: 'bucket-banco' }))).toThrow(ErrorEntorno);
  });

  it('el error por clave sobrante no cita su nombre', () => {
    try {
      leerEntorno(conBucket(decl({ CLAVE_PEGADA_XYZ: 1 })));
    } catch (e) {
      expect((e as Error).message).not.toContain('CLAVE_PEGADA_XYZ');
      return;
    }
    throw new Error('debía fallar');
  });
});

describe('interruptor del enrutador (CHATBOTRAG_ENRUTADOR)', () => {
  it('ausente o vacío = apagado', () => {
    expect(leerEntorno(base()).enrutador).toBe('apagado');
    expect(leerEntorno(base({ CHATBOTRAG_ENRUTADOR: '' })).enrutador).toBe('apagado');
  });

  it.each(['apagado', 'activo', 'activo_fijo'] as const)('acepta «%s»', (valor) => {
    expect(leerEntorno(base({ CHATBOTRAG_ENRUTADOR: valor })).enrutador).toBe(valor);
  });

  it.each(['ACTIVO', 'encendido', 'true', 'fijo'])('un valor desconocido («%s») detiene el arranque, no se toma por apagado', (valor) => {
    expect(() => leerEntorno(base({ CHATBOTRAG_ENRUTADOR: valor }))).toThrow(ErrorEntorno);
  });
});
