import { describe, expect, it } from 'vitest';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { ErrorConfiguracion, validarConfiguracion } from './cargar.js';
import { datosQueNoTenemos, horarioLegible } from './derivados.js';
import { ErrorPerfil, fusionar, listarPerfiles, resolverConfiguracion } from './perfiles.js';

describe('esquema y validación', () => {
  it('acepta la configuración de prueba y aplica valores por defecto', () => {
    const c = validarConfiguracion(CONFIG_PRUEBA);
    expect(c.voz.longitud).toBe('breve');
    expect(c.conocimiento.topK).toBe(3);
    expect(c.modelo.temperatura).toBe(0.3);
    expect(c.seguridad.marcasPermitidas).toEqual(['DERIVAR']);
  });

  it('rechaza claves desconocidas (strict) y explica dónde', () => {
    expect(() => validarConfiguracion({ ...CONFIG_PRUEBA, horarioLegible: 'x' })).toThrow(ErrorConfiguracion);
    try {
      validarConfiguracion({ ...CONFIG_PRUEBA, voz: { tratamiento: 'vos' } });
    } catch (e) {
      expect((e as ErrorConfiguracion).detalles.join(' ')).toMatch(/voz\.tratamiento/);
    }
  });

  it('rechaza secretos incrustados por forma y por nombre de campo', () => {
    const conClave = structuredClone(CONFIG_PRUEBA);
    conClave.datos = { ...conClave.datos, hechos: ['AIzaSyD-EJEMPLO-1234567890abcdefghijklmn'] };
    expect(() => validarConfiguracion(conClave)).toThrow(ErrorConfiguracion);
    try {
      validarConfiguracion(conClave);
    } catch (e) {
      expect((e as ErrorConfiguracion).detalles.join(' ')).toMatch(/secreto/);
    }
  });

  it('rechaza facetas de orientación con vocabulario sensible', () => {
    const c = structuredClone(CONFIG_PRUEBA);
    c.orientacion!.facetas!.push({ id: 'salud', pregunta: '¿Tiene alguna enfermedad diagnosticada?', opciones: ['sí', 'no'] });
    expect(() => validarConfiguracion(c)).toThrow(ErrorConfiguracion);
    try {
      validarConfiguracion(c);
    } catch (e) {
      expect((e as ErrorConfiguracion).detalles.join(' ')).toMatch(/sensibles/);
    }
  });

  it('exige que perfilPorDefecto exista', () => {
    expect(() => validarConfiguracion({ ...CONFIG_PRUEBA, perfilPorDefecto: 'NOEXISTE' })).toThrow(ErrorConfiguracion);
  });
});

describe('perfiles', () => {
  const c = validarConfiguracion(CONFIG_PRUEBA);

  it('sin perfil devuelve la base', () => {
    const e = resolverConfiguracion(c, null);
    expect(e.perfilId).toBeNull();
    expect(e.conocimiento.fuentes).toHaveLength(2);
    expect('perfiles' in e).toBe(false);
  });

  it('un perfil reemplaza arreglos y fusiona objetos', () => {
    const e = resolverConfiguracion(c, 'VIDA');
    expect(e.perfilNombre).toBe('Seguro de Vida');
    expect(e.alcance.temasPermitidos).toEqual(['vida']); // reemplazo
    expect(e.alcance.accionesProhibidas).toEqual(['emitir pólizas', 'cobrar', 'firmar']); // heredado
    expect(e.conocimiento.fuentes.map((f) => f.id)).toEqual(['vida']); // reemplazo
    expect(e.conocimiento.topK).toBe(3); // heredado
    expect(e.voz.tratamiento).toBe('usted');
  });

  it('otro perfil cambia la voz y vacía la orientación', () => {
    const e = resolverConfiguracion(c, 'AUTO');
    expect(e.voz.tratamiento).toBe('tu');
    expect(e.orientacion.facetas).toEqual([]);
  });

  it('un perfil desconocido no cae a la base en silencio', () => {
    expect(() => resolverConfiguracion(c, 'HOGAR')).toThrow(ErrorPerfil);
  });

  it('lista los perfiles para el selector del cliente', () => {
    expect(listarPerfiles(c).map((p) => p.id)).toEqual(['VIDA', 'AUTO']);
  });

  it('fusionar no muta la base', () => {
    const base = { a: { b: 1, c: [1] }, d: 'x' };
    const r = fusionar(base, { a: { c: [2] } });
    expect(r).toEqual({ a: { b: 1, c: [2] }, d: 'x' });
    expect(base.a.c).toEqual([1]);
  });
});

describe('derivados', () => {
  const c = validarConfiguracion(CONFIG_PRUEBA);
  it('horario legible en orden de días', () => {
    expect(horarioLegible(c.operacion.horarios)).toBe('lunes: 08:00-18:00; viernes: 08:00-17:00; domingo: cerrado');
    expect(horarioLegible({})).toBe('');
  });
  it('datos que no tenemos = calculados + declarados', () => {
    const e = resolverConfiguracion(c, null);
    expect(datosQueNoTenemos(e)).toEqual(['la dirección física', 'comisiones de los corredores']);
  });
});
