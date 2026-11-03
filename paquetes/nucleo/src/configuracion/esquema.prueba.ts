import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cargarConfiguracionDesdeJson, validarConfiguracion } from './cargar.js';
import { resolverConfiguracion } from './perfiles.js';
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
  it('reserva el id de perfil «paquete» (cualquier capitalización) y las colecciones que terminan en --paquete', () => {
    for (const id of ['PAQUETE', 'Paquete']) {
      expect(detalles(() => validarConfiguracion({ ...CONFIG_PRUEBA, perfiles: { [id]: { nombre: 'X' } } }))).toMatch(/reservado/);
    }
    expect(detalles(() => validarConfiguracion({ ...CONFIG_PRUEBA, conocimiento: { ...CONFIG_PRUEBA.conocimiento, coleccion: 'kuaa--paquete' } }))).toMatch(/--paquete/);
    expect(detalles(() => validarConfiguracion({ ...CONFIG_PRUEBA, perfiles: { PA: { nombre: 'A', conocimiento: { coleccion: 'otra--paquete' } } } }))).toMatch(/--paquete/);
    expect(validarConfiguracion({ ...CONFIG_PRUEBA, conocimiento: { ...CONFIG_PRUEBA.conocimiento, coleccion: 'kuaa-paquete' } }).conocimiento.coleccion).toBe('kuaa-paquete');
  });
});

describe('enrutador', () => {
  const con = (enrutador: unknown) => ({ ...CONFIG_PRUEBA, enrutador });
  it('está apagado por defecto en la validación y en la configuración efectiva', () => {
    const c = validarConfiguracion(CONFIG_PRUEBA);
    expect(c.enrutador).toEqual({ activo: false, carrilFijo: false });
    expect(resolverConfiguracion(c, null).enrutador).toEqual({ activo: false, carrilFijo: false });
  });
  it('admite activo y activo con carrilFijo', () => {
    expect(validarConfiguracion(con({ activo: true })).enrutador).toEqual({ activo: true, carrilFijo: false });
    expect(validarConfiguracion(con({ activo: true, carrilFijo: true })).enrutador).toEqual({ activo: true, carrilFijo: true });
  });
  it('carrilFijo sin activo falla', () => {
    expect(detalles(() => validarConfiguracion(con({ carrilFijo: true })))).toMatch(/enrutador\.carrilFijo exige enrutador\.activo/);
  });
  it('rechaza claves extra y valores que no son booleanos', () => {
    expect(() => validarConfiguracion(con({ activo: true, extra: 1 }))).toThrow();
    expect(() => validarConfiguracion(con({ activo: 'true' }))).toThrow();
  });
  it('un perfil no puede definirlo', () => {
    expect(() => validarConfiguracion({ ...CONFIG_PRUEBA, perfiles: { PA: { nombre: 'A', enrutador: { activo: true } } } })).toThrow();
  });
  it('las configuraciones de ejemplo cargan con el enrutador apagado', () => {
    for (const f of ['segurolotengo.json', 'comercio-agendamiento.json', 'kuaa.json']) {
      const c = cargarConfiguracionDesdeJson(readFileSync(RAIZ + f, 'utf8'));
      expect(c.enrutador.activo).toBe(false);
      expect(c.enrutador.carrilFijo).toBe(false);
    }
  });
  it('el JSON Schema declara los valores por defecto en false', () => {
    const esquema = JSON.parse(readFileSync(fileURLToPath(new URL('../../esquemas/configuracion-agente.schema.json', import.meta.url)), 'utf8')) as {
      properties: { enrutador: { properties: Record<string, { default: boolean }> } };
    };
    expect(esquema.properties.enrutador.properties['activo']?.default).toBe(false);
    expect(esquema.properties.enrutador.properties['carrilFijo']?.default).toBe(false);
  });
});
