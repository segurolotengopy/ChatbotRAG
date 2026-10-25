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
 * MANUALES DE PANTALLA (decisión de Andres, 2026-10-25). Los 21 manuales de
 * `manuales/` los entrega SeguroLoTengo y citan LITERALMENTE los textos del portal,
 * que está en tuteo («Elige tu plan», «Te quedan N intentos»). Por eso la prueba de
 * «usted» exime en esos archivos, y solo en ellos, (a) lo que va entre «…», (b) los
 * títulos H1 (nombres literales de pantalla) y (c) el comentario HTML inicial. La
 * narración de los manuales, `orientacion/**`, `interno/**` y la configuración siguen
 * igual de estrictas. Dos exenciones análogas valen para la prueba de teléfonos: los
 * montos precedidos por `Gs.` y el número de ejemplo «981 000 000» de la pantalla de
 * WhatsApp. Qué NO garantiza: que el modelo no imite el «tú» de una cita al responder;
 * eso lo mide la batería de casos de SeguroLoTengo, no esta prueba.
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
const NUMERO_DE_EJEMPLO = '981 000 000';

/**
 * Quita de un manual de pantalla lo que se cita literalmente del portal: el comentario
 * HTML inicial, las líneas H1 y el texto entre «…». Lo que queda es la narración, que
 * sí debe ir en «usted». Es función pura para poder probar que la exención no se cuela.
 */
function sinCitasDePantalla(texto: string): string {
  return texto
    .replace(/^\s*<!--[\s\S]*?-->/, '')
    .replace(/^# .*$/gm, '')
    .replace(/«[^»]*»/g, '');
}

/** Teléfonos de un texto, sin los montos en guaraníes ni el número de ejemplo de la pantalla. */
function telefonosInformados(texto: string): string[] {
  const salida: string[] = [];
  for (const m of texto.matchAll(TELEFONO)) {
    const antes = texto.slice(0, m.index);
    if (/Gs\.?\s*$/.test(antes) || m[0] === NUMERO_DE_EJEMPLO) continue;
    salida.push(m[0]);
  }
  return salida;
}

const VOSEO_O_TUTEO = /(?<![\p{L}])(?:vos|tu|tus|te|ti|podés|querés|necesitás|tenés|sabés|repetís|recibís|contame|decime|escribime|tené|fijate|acercarte|contarte|informarte|explicarte|acá)(?![\p{L}])/iu;

describe('fuentes del asistente de SeguroLoTengo', () => {
  it('cada archivo referenciado existe', () => {
    for (const r of publicas) {
      expect(existsSync(new URL(r.ruta, CORPUS)), `${r.donde}: «${r.id}» apunta a ${r.ruta}, que no existe`).toBe(true);
    }
  });

  it('el perfil con producto disponible carga 22 documentos de orientación y 21 manuales de pantalla', () => {
    // Antes eran solo los 22 de orientación; el 2026-10-25 se sumaron los 21 manuales de
    // pantalla de SeguroLoTengo (uno por página), así que el perfil carga 43 fuentes.
    const ids = (config.perfiles['VIDA_ONCOLOGICO']?.conocimiento?.fuentes ?? []).map((f) => f.id);
    expect(ids.filter((id) => id.startsWith('orientacion-'))).toHaveLength(22);
    expect(ids.filter((id) => id.startsWith('manual-'))).toHaveLength(21);
    expect(ids).toHaveLength(43);
    expect(new Set(ids).size, 'hay ids de fuente repetidos').toBe(ids.length);
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
      const texto = leer(r.ruta);
      const evaluado = r.ruta.startsWith('segurolotengo/manuales/') ? sinCitasDePantalla(texto) : texto;
      expect(evaluado, `${r.ruta} usa voseo o tuteo`).not.toMatch(VOSEO_O_TUTEO);
    }
  });

  it('la exención de citas de pantalla es estrecha: un «tu» en la narración sí falla', () => {
    const base = '<!-- pagina_id: x | ruta: / -->\n# Elige tu plan\nLa pantalla dice «Revisa tu conexión» y «Te quedan N intentos».\n';
    expect(sinCitasDePantalla(base)).not.toMatch(VOSEO_O_TUTEO);
    expect(sinCitasDePantalla(`${base}Revise tu conexión antes de seguir.\n`)).toMatch(VOSEO_O_TUTEO);
    expect(sinCitasDePantalla(`${base}## Tu paso\n`)).toMatch(VOSEO_O_TUTEO);
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
      for (const tel of telefonosInformados(t)) {
        expect(tel.replace(/\D/g, ''), `${r.ruta} informa un teléfono distinto: ${tel}`).toBe(WHATSAPP_DIGITOS);
      }
      expect(t, `${r.ruta} informa el teléfono de Alianza como canal`).not.toMatch(/236\s*0000/);
    }
  });

  it('la exención de montos y del número de ejemplo es estrecha: un teléfono real distinto sí cuenta', () => {
    expect(telefonosInformados('cáncer Gs. 100.000.000 y renta Gs 50.000.000')).toEqual([]);
    expect(telefonosInformados('por ejemplo 981 000 000')).toEqual([]);
    expect(telefonosInformados('llame al 021 236 0000')).toHaveLength(1);
    expect(telefonosInformados('llame al 0981 123 456')).toHaveLength(1);
    expect(telefonosInformados('llame al +595 991 478 468')).toHaveLength(1);
  });
});
