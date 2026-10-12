/**
 * CORPUS DEL ASISTENTE DE SEGUROLOTENGO
 *
 * Las fuentes que la configuración referencia son lo único que el asistente puede
 * citar, y este repositorio es PÚBLICO. Esta prueba lee los archivos REALES que se
 * despliegan y comprueba lo que ninguna regla de alcance garantiza:
 *
 *  1. Que cada archivo referenciado exista: una ruta rota deja al perfil sin base
 *     y el asistente respondería «sin respaldo» a todo.
 *  2. Que los archivos de orientación lleguen SIN el encabezado de su origen. Traían
 *     un bloque `fuente:` con rutas del repositorio privado, que no debe publicarse;
 *     y mi cargador toma título y versión de la configuración, así que el bloque solo
 *     metería ruido en el primer fragmento.
 *  3. Que no quede el nombre anterior del producto, ni el teléfono de la aseguradora
 *     como canal de atención, ni montos en pesos.
 *  4. Que los únicos contactos sean los confirmados. El verificador de salida del
 *     portal retiene toda respuesta con un teléfono o correo que no sea de las
 *     entidades.
 *
 * Qué NO garantiza: que el contenido sea correcto ni que el modelo lo cite bien. Eso
 * lo miden las baterías de casos del portal.
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cargarConfiguracionDesdeJson } from '@chatbotrag/nucleo';

const CORPUS = new URL('../../configuraciones/corpus/', import.meta.url);
const config = cargarConfiguracionDesdeJson(readFileSync(new URL('../../configuraciones/segurolotengo.json', import.meta.url), 'utf8'));

interface Referencia {
  readonly donde: string;
  readonly id: string;
  readonly version: string;
  readonly ruta: string;
  readonly interno: boolean;
}

function referencias(): Referencia[] {
  const salida: Referencia[] = [];
  for (const f of config.conocimiento.fuentes) salida.push({ donde: 'global', id: f.id, version: f.version, ruta: f.ruta, interno: f.visibilidad === 'interno' });
  for (const [perfil, p] of Object.entries(config.perfiles)) {
    for (const f of p.conocimiento?.fuentes ?? []) salida.push({ donde: perfil, id: f.id, version: f.version, ruta: f.ruta, interno: f.visibilidad === 'interno' });
  }
  return salida;
}

const publicas = referencias().filter((r) => !r.interno);
const leer = (ruta: string): string => readFileSync(new URL(ruta, CORPUS), 'utf8');
const orientacion = publicas.filter((r) => r.ruta.startsWith('segurolotengo/orientacion/'));

const WHATSAPP_DIGITOS = '595991478468';
const CORREO_UNICO = 'segurolotengo@interseguros360.com';
const CORREO = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu;
const TELEFONO = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,12}(?!\d)/g;
const VOSEO_O_TUTEO = /(?<![\p{L}])(?:vos|tu|tus|te|ti|podés|querés|necesitás|tenés|sabés|repetís|recibís|contame|decime|escribime|tené|fijate|acercarte|contarte|informarte|explicarte|acá)(?![\p{L}])/iu;

describe('fuentes del asistente de SeguroLoTengo', () => {
  it('cada archivo referenciado existe', () => {
    for (const r of publicas) {
      expect(existsSync(new URL(r.ruta, CORPUS)), `${r.donde}: «${r.id}» apunta a ${r.ruta}, que no existe`).toBe(true);
    }
  });

  it('el perfil con producto disponible carga los 22 documentos de orientación', () => {
    const ids = (config.perfiles['VIDA_ONCOLOGICO']?.conocimiento?.fuentes ?? []).map((f) => f.id);
    expect(ids).toHaveLength(22);
    expect(ids.every((id) => id.startsWith('orientacion-'))).toBe(true);
  });

  it('todos los documentos de orientación llevan la misma versión', () => {
    expect(new Set(orientacion.map((r) => r.version))).toEqual(new Set(['ORIENTACION-v1.0']));
  });
});

describe('contenido de los documentos de orientación', () => {
  it('llegan sin el encabezado de su origen ni rutas del repositorio privado', () => {
    for (const r of orientacion) {
      const t = leer(r.ruta);
      expect(t.startsWith('---'), `${r.ruta} conserva el bloque de encabezado`).toBe(false);
      expect(t, `${r.ruta} conserva una línea «fuente:»`).not.toMatch(/^fuente:/im);
      expect(t, `${r.ruta} nombra una ruta de código del repositorio privado`).not.toMatch(/src\/domain\//);
      expect(t, `${r.ruta} conserva una huella sha256 de origen`).not.toMatch(/sha256/i);
    }
  });

  it('no traen importes en guaraníes ni en dólares', () => {
    for (const r of orientacion) {
      expect(leer(r.ruta), `${r.ruta} contiene un importe`).not.toMatch(/Gs\.?\s*\d|USD\s*\d|US\$|\$\s*\d/i);
    }
  });
});

describe('todas las fuentes públicas que se cargan', () => {
  it('ninguna usa el nombre anterior del producto', () => {
    for (const r of publicas) {
      expect(leer(r.ruta), `${r.ruta} nombra el producto como CONFÍO`).not.toMatch(/conf[ií]o/i);
    }
  });

  it('están en usted: sin voseo ni tuteo', () => {
    for (const r of publicas) {
      expect(leer(r.ruta), `${r.ruta} usa voseo o tuteo`).not.toMatch(VOSEO_O_TUTEO);
    }
  });

  it('el único correo que informan es el de contacto', () => {
    for (const r of publicas) {
      const correos = [...new Set((leer(r.ruta).match(CORREO) ?? []).map((c) => c.toLowerCase()))];
      for (const c of correos) expect(c, `${r.ruta} informa un correo distinto`).toBe(CORREO_UNICO);
    }
  });

  it('el único teléfono que informan es el WhatsApp de atención, no el de la aseguradora', () => {
    for (const r of publicas) {
      const t = leer(r.ruta);
      for (const tel of t.match(TELEFONO) ?? []) {
        expect(tel.replace(/\D/g, ''), `${r.ruta} informa un teléfono distinto: ${tel}`).toBe(WHATSAPP_DIGITOS);
      }
      expect(t, `${r.ruta} informa el teléfono de Alianza como canal`).not.toMatch(/236\s*0000/);
    }
  });
});
