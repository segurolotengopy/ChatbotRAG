/**
 * ALCANCE DEL ASISTENTE DE SEGUROLOTENGO
 *
 * El asistente explica el funcionamiento del sitio y los procedimientos; no
 * informa sobre el producto. Esa decisión (2026-10-11) vive en la configuración
 * y se puede deshacer sin querer de tres maneras que una regla de alcance sola
 * no impide:
 *
 *  1. Dejar cargadas las fuentes con coberturas o precios: el modelo las recupera
 *     aunque el alcance las prohíba, y basta un mensaje torcido para que las use.
 *  2. Dejar la herramienta `recomendar_opcion` y sus reglas: devuelve precios y
 *     sumas aseguradas como texto fijo, que el servicio entrega SIN pasar por el
 *     modelo, así que ninguna compuerta de salida lo frena.
 *  3. Reponer en los mensajes fijos la promesa de explicar planes y coberturas.
 *
 * EXCEPCIÓN DECIDIDA (Andres, 2026-10-25): el asistente SÍ puede citar precios y
 * montos tal como aparecen en la pantalla /plan, y se ingesta `plan.md` completo
 * (fuente `manual-plan`). Es la ÚNICA excepción a la regla 1; lo demás sigue igual:
 * sin recomendar plan, sin comparar para decidir y sin evaluar un caso particular.
 * Hoy la excepción no es necesaria, porque ningún id ni ruta coincide con
 * FUENTE_DE_PRODUCTO (ni siquiera `manual-plan`); se deja escrita para documentar la
 * decisión y para que siga valiendo si el regex se amplía.
 * Los montos en guaraníes solo pueden vivir en los archivos listados en
 * MANUALES_CON_MONTOS; cualquier otro archivo con un monto hace fallar la prueba.
 *
 * Esta prueba lee la configuración REAL, la que se despliega, y no un ejemplo.
 * Qué NO garantiza: que el modelo respete el alcance ante un mensaje adverso.
 * Eso lo miden las baterías de casos fuera de alcance, no esta prueba.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  aplicarCompuertasSalida,
  Agente,
  BitacoraEnMemoria,
  cargarConfiguracionDesdeJson,
  IndiceEnMemoria,
  MemoriaEnProceso,
  normalizar,
  ProveedorSimulado,
  RegistroHerramientas,
  resolverConfiguracion,
} from '@chatbotrag/nucleo';
import type { PeticionLLM } from '@chatbotrag/nucleo';

const RUTA = new URL('../../configuraciones/segurolotengo.json', import.meta.url);
const config = cargarConfiguracionDesdeJson(readFileSync(RUTA, 'utf8'));

/** Lo que se busca en las fuentes: el contenido de producto que quedó fuera de alcance. */
const FUENTE_DE_PRODUCTO = /cobertura|exclusion|planes?-|premio|poliza|carencia/i;
/** Fuentes de producto que se admiten por decisión expresa (ver cabecera). */
const EXCEPCIONES_DE_FUENTE_DE_PRODUCTO = ['manual-plan'];
/** Archivos del corpus (ruta relativa a corpus/segurolotengo/) que pueden traer montos. */
const MANUALES_CON_MONTOS = ['manuales/plan.md'];
/** Un monto en guaraníes: `Gs. 319.000`, `Gs 50.000.000`. */
const MONTO = /Gs\.?\s*\d/;

const perfiles = Object.entries(config.perfiles);

describe('alcance del asistente de SeguroLoTengo: funcionamiento, no producto', () => {
  it('declara cuatro perfiles, los mismos ids que usa el catálogo del portal', () => {
    expect(Object.keys(config.perfiles).sort()).toEqual(['ACCIDENTES_PERSONALES', 'RESPONSABILIDAD_CIVIL', 'VIDA', 'VIDA_ONCOLOGICO']);
  });

  it('ningún perfil carga fuentes de coberturas, exclusiones, planes o premios, salvo manual-plan', () => {
    for (const [id, perfil] of perfiles) {
      for (const f of perfil.conocimiento?.fuentes ?? []) {
        if (EXCEPCIONES_DE_FUENTE_DE_PRODUCTO.includes(f.id)) continue;
        expect(`${id}: ${f.id} ${f.ruta}`, `el perfil ${id} carga la fuente de producto «${f.id}»`).not.toMatch(FUENTE_DE_PRODUCTO);
      }
    }
    for (const f of config.conocimiento.fuentes) {
      if (EXCEPCIONES_DE_FUENTE_DE_PRODUCTO.includes(f.id)) continue;
      expect(`${f.id} ${f.ruta}`, `la configuración global carga la fuente de producto «${f.id}»`).not.toMatch(FUENTE_DE_PRODUCTO);
    }
  });

  it('los montos en guaraníes solo aparecen en los archivos del corpus autorizados, nunca en la configuración ni en orientación', () => {
    // Decisión del 2026-10-25: solo el manual de /plan cita montos. Esto fija la lista exacta:
    // un monto nuevo en otro manual, en orientación o en la configuración rompe la prueba.
    const base = new URL('../../configuraciones/corpus/segurolotengo/', import.meta.url);
    const conMontos: string[] = [];
    const recorrer = (dir: URL, prefijo: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) recorrer(new URL(`${e.name}/`, dir), `${prefijo}${e.name}/`);
        else if (e.name.endsWith('.md') && MONTO.test(readFileSync(new URL(e.name, dir), 'utf8'))) conMontos.push(`${prefijo}${e.name}`);
      }
    };
    recorrer(base, '');
    expect(conMontos.sort()).toEqual([...MANUALES_CON_MONTOS].sort());
    expect(cadenas(crudo).filter((c) => MONTO.test(c)), 'la configuración contiene un monto').toEqual([]);
  });

  it('ningún perfil ofrece la herramienta que recomienda plan', () => {
    for (const [id, perfil] of perfiles) {
      const nombres = (perfil.herramientas ?? []).map((h) => h.nombre);
      expect(nombres, `el perfil ${id} ofrece recomendar_opcion`).not.toContain('recomendar_opcion');
    }
    expect(config.herramientas.map((h) => h.nombre)).not.toContain('recomendar_opcion');
  });

  it('ninguna regla de orientación puede devolver un texto fijo con montos', () => {
    // Las reglas de orientación las entrega el servicio tal cual, sin pasar por
    // el modelo ni por las compuertas de salida: un monto ahí sale directo.
    const todas = [config.orientacion, ...perfiles.map(([, p]) => p.orientacion)];
    for (const o of todas) {
      for (const r of o?.reglas ?? []) {
        expect(r.texto, 'una regla de orientación devuelve un monto').not.toMatch(MONTO);
      }
    }
  });

  it('los mensajes fijos no prometen explicar planes, coberturas ni carencias', () => {
    const fijos = [config.mensajes.bienvenida, config.mensajes.fueraDeAlcance];
    for (const m of fijos) {
      expect(m, 'un mensaje fijo promete lo que ya no se responde').not.toMatch(/planes|coberturas|carencias|exclusiones/i);
    }
  });

  it('los hechos que se inyectan al prompt no hablan de precios ni de premios', () => {
    // `datos.hechos` va al prompt del modelo como verdad establecida. Un hecho
    // sobre premios lo invita a hablar de precios, que está fuera de alcance.
    for (const h of config.datos.hechos) {
      expect(h, 'un hecho del prompt habla de precios o premios').not.toMatch(/premio|precio|prima|gs\.?\s*\d|guaran/i);
    }
  });

  it('declara como bloqueados los temas de producto que se sacaron del alcance', () => {
    const bloqueados = config.alcance.temasBloqueados.join(' | ').toLowerCase();
    expect(bloqueados).toContain('recomendar');
    expect(bloqueados).toContain('cubierto');
    // El permitido cita lo que muestra la pantalla y ya no promete «sin recomendar ni comparar».
    const permitidos = config.alcance.temasPermitidos.join(' | ').toLowerCase();
    expect(permitidos).toContain('según la pantalla');
    expect(permitidos).not.toContain('recomendar ni comparar');
    // Los precios ya no se bloquean como tema: se citan como los muestra la pantalla.
    expect(bloqueados).not.toContain('precios');
  });
});

/** Todas las cadenas de la configuración, a cualquier profundidad. */
function cadenas(valor: unknown, acc: string[] = []): string[] {
  if (typeof valor === 'string') acc.push(valor);
  else if (Array.isArray(valor)) for (const v of valor) cadenas(v, acc);
  else if (valor !== null && typeof valor === 'object') for (const v of Object.values(valor)) cadenas(v, acc);
  return acc;
}
const crudo: unknown = JSON.parse(readFileSync(RUTA, 'utf8'));

/**
 * Voseo y tuteo en lo que el asistente le dice a la persona. El portal y el corpus
 * de orientación van en «usted»; una respuesta en voseo dentro de esa misma
 * pantalla se lee como dos voces distintas. Se midió el 2026-10-11: la primera
 * respuesta real salió con «recibís» porque `voz.tratamiento` valía `vos` y los
 * textos fijos estaban en voseo. Se usan límites de letra Unicode porque `\b` de
 * JavaScript no reconoce las vocales acentuadas.
 */
const VOSEO_O_TUTEO = /(?<![\p{L}])(?:vos|tu|tus|te|ti|podés|querés|necesitás|tenés|sabés|repetís|recibís|contame|decime|escribime|tené|fijate|acercarte|contarte|informarte|explicarte|acá)(?![\p{L}])/iu;

describe('trato de usted con quien consulta', () => {
  it('el tratamiento configurado es usted', () => {
    expect(config.voz.tratamiento).toBe('usted');
  });

  it('ningún texto de la configuración está en voseo ni en tuteo', () => {
    for (const c of cadenas(crudo)) {
      expect(c, 'un texto de la configuración usa voseo o tuteo').not.toMatch(VOSEO_O_TUTEO);
    }
  });
});

/**
 * El producto se llamó «CONFÍO» y hoy se llama «VIVE». El verificador de salida
 * del portal retiene toda respuesta que nombre «CONFÍO» como plan, así que un
 * texto fijo con el nombre viejo lo descartaría y lo reemplazaría por la
 * derivación. No se citan nombres de plan de VIVE: este repositorio no los tiene.
 */
describe('nombre vigente del producto', () => {
  it('ningún texto de la configuración usa el nombre anterior', () => {
    for (const c of cadenas(crudo)) {
      expect(c, 'un texto de la configuración nombra el producto como CONFÍO').not.toMatch(/conf[ií]o/i);
    }
  });

  it('el perfil con producto disponible se llama VIVE', () => {
    expect(config.perfiles['VIDA_ONCOLOGICO']?.nombre).toBe('Seguro de Vida Oncológico VIVE');
  });
});

/**
 * DATOS DE CONTACTO. La fuente única es `src/domain/entidades.ts` del repositorio
 * del portal (`WHATSAPP_ATENCION`, `INTERSEGUROS.domicilio`, `CORREO_RETRACTO_Y_DATOS`).
 * Aquí no se inventan: se copian y esta prueba los ancla. Si el portal los cambia,
 * hay que cambiarlos en la configuración y en esta prueba a la vez.
 *
 * El verificador de salida del portal retiene toda respuesta con un teléfono o un
 * correo que no sea de las entidades, así que un dato distinto aquí haría que el
 * mensaje de derivación se descarte.
 */
const WHATSAPP_ATENCION = '+595 991 478 468';
const WHATSAPP_DIGITOS = '595991478468';
const CORREO_UNICO = 'segurolotengo@interseguros360.com';
const DOMICILIO = 'Avda. Aviadores del Chaco 2351, Campos Cervera, Edificio Plaza Center 7.º piso, Asunción';
const CORREO = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[a-z]{2,}/giu;
const TELEFONO = /(?<!\d)\+?\d(?:[\s().-]{0,2}\d){8,12}(?!\d)/g;

describe('datos de contacto de Interseguros', () => {
  it('el WhatsApp de atención figura en la derivación, en el servicio suspendido y en el contacto humano', () => {
    expect(config.mensajes.derivacion).toContain(WHATSAPP_ATENCION);
    expect(config.mensajes.suspendido).toContain(WHATSAPP_ATENCION);
    expect(config.operacion.contactoHumano.texto).toContain(WHATSAPP_ATENCION);
    expect(config.operacion.contactoHumano.whatsapp).toBe(WHATSAPP_DIGITOS);
  });

  it('el domicilio es el exacto, con «Campos Cervera», en todo lugar donde se nombra', () => {
    expect(config.mensajes.derivacion).toContain(DOMICILIO);
    expect(config.operacion.contactoHumano.texto).toContain(DOMICILIO);
    expect(config.datos.direccion).toContain(DOMICILIO);
  });

  it('el único correo que se informa es el de contacto', () => {
    const correos = cadenas(crudo).flatMap((c) => c.match(CORREO) ?? []);
    expect([...new Set(correos.map((c) => c.toLowerCase()))]).toEqual([CORREO_UNICO]);
  });

  it('el único teléfono que se informa es el WhatsApp de atención, no el de la aseguradora', () => {
    const telefonos = cadenas(crudo).flatMap((c) => c.match(TELEFONO) ?? []);
    expect(telefonos.length, 'debería haber al menos un teléfono informado').toBeGreaterThan(0);
    for (const tel of telefonos) {
      expect(tel.replace(/\D/g, ''), `un teléfono distinto del WhatsApp de atención: ${tel}`).toBe(WHATSAPP_DIGITOS);
    }
    // Alianza Garantía tiene teléfono propio, pero NO es canal de atención de este asistente.
    expect(cadenas(crudo).join(' ')).not.toMatch(/236\s*0000/);
  });

  it('no declara un horario de atención que nadie confirmó', () => {
    // Se pidió a Interseguros y no hay horario confirmado: solo se sabe «en horario
    // hábil». Un horario con cifras sería un dato inventado dicho como cierto, y la
    // herramienta `consultar_horarios` lo repetiría tal cual. Cuando se confirme, se
    // carga en `operacion.horarios` y se actualiza esta prueba.
    expect(Object.keys(config.operacion.horarios)).toEqual([]);
  });

  it('no existe traspaso a una persona: el modo es «canal» y ninguna herramienta lo promete', () => {
    // Batería del 12-oct-2026: en 40 de 368 casos el asistente ofreció «derivarle con un
    // asesor humano» —17 sin dar el canal— y ese traspaso no existe. Una herramienta
    // descrita como «deriva a un asesor» se lo sugiere al modelo.
    expect(config.operacion.contactoHumano.modo).toBe('canal');
    const herramientas = [config.herramientas, ...perfiles.map(([, p]) => p.herramientas ?? [])].flat();
    for (const h of herramientas) expect(h.descripcion, h.nombre).not.toMatch(/asesor|deriva a|transfiere a/i);
  });

  it('el modelo no puede revelar el motor: la respuesta se reemplaza y trae el canal oficial', () => {
    // Batería del 12-oct-2026: INY-010 e INY-021 respondieron «soy Gemini» y «modelo
    // entrenado por Google». Se frenan frases que REVELAN el motor, no la palabra
    // «Google» suelta: «Google Chrome», «Google Maps» o «Google Play» son respuestas
    // legítimas de orientación (cámara bloqueada en el navegador, la app, el mapa).
    const efectiva = resolverConfiguracion(config, 'VIDA_ONCOLOGICO');
    for (const frase of ['Soy Gemini, un modelo de lenguaje.', 'Fui entrenado por Google.', 'Soy un modelo de Google.', 'Corro sobre Vertex AI.']) {
      const r = aplicarCompuertasSalida(frase, { config: efectiva });
      expect(r.reemplazada, frase).toBe(true);
      expect(r.texto, frase).toContain(efectiva.mensajes.fueraDeAlcance);
      expect(r.texto, frase).toContain(efectiva.mensajes.derivacion);
    }
    for (const frase of ['Pruebe con otro navegador, como Google Chrome o Firefox.', 'Puede buscarla en Google Maps.', 'Descargue la app desde Google Play.']) {
      expect(aplicarCompuertasSalida(frase, { config: efectiva }).reemplazada, frase).toBe(false);
    }
  });

  it('ningún texto del corpus ni de la configuración contiene un término confidencial', () => {
    // Un documento o un perfil futuro que nombre el motor quedaría bloqueado sin aviso.
    const resto = { ...config, modelo: undefined, seguridad: undefined };
    const textos = [JSON.stringify(resto)];
    const carpeta = new URL('../../configuraciones/corpus/segurolotengo/', import.meta.url);
    const recorrer = (dir: URL): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        // `interno/` no se indexa ni se muestra: puede nombrar los términos que se vedan.
        if (e.isDirectory()) { if (e.name !== 'interno') recorrer(new URL(`${e.name}/`, dir)); }
        else if (e.name.endsWith('.md')) textos.push(readFileSync(new URL(e.name, dir), 'utf8'));
      }
    };
    recorrer(carpeta);
    const todo = normalizar(textos.join('\n'));
    for (const t of config.seguridad.terminosConfidenciales) expect(todo, t).not.toContain(normalizar(t));
  });

  it('promete_traspaso está activa: quita la oración que ofrece un asesor y agrega el canal', () => {
    const efectiva = resolverConfiguracion(config, 'VIDA_ONCOLOGICO');
    const r = aplicarCompuertasSalida('Eso lo explica el paso 3. Le derivo con un asesor humano para que lo ayude.', { config: efectiva });
    expect(r.avisos).toContain('promete_traspaso');
    expect(r.texto).toContain('Eso lo explica el paso 3.');
    expect(r.texto).not.toMatch(/asesor/i);
    expect(r.texto).toContain(efectiva.mensajes.derivacion);
  });
});

describe('compuerta de entrada de SeguroLoTengo: por dato, no por palabra', () => {
  it('usa vocabularioEntrada «dato»', () => {
    expect(config.seguridad.vocabularioEntrada).toBe('dato');
  });

  it('sigue bloqueando todas las categorías de datos sensibles', () => {
    for (const c of ['cedula', 'tarjeta', 'salud', 'pep', 'otp', 'clave', 'inyeccion'] as const) {
      expect(config.seguridad.bloquearEntrada).toContain(c);
    }
  });
});

describe('compuerta de entrada por dato, de punta a punta con la configuración real', () => {
  function armar() {
    const bitacora = new BitacoraEnMemoria();
    const peticiones: PeticionLLM[] = [];
    const simulado = new ProveedorSimulado();
    const proveedor = {
      nombre: 'simulado-contado',
      generar: async (p: PeticionLLM) => {
        peticiones.push(p);
        return simulado.generar(p);
      },
    };
    const agente = new Agente({
      config,
      proveedor,
      indice: new IndiceEnMemoria(null),
      memoria: new MemoriaEnProceso(),
      herramientas: new RegistroHerramientas(),
      bitacora,
      reloj: () => new Date('2026-10-19T14:00:00Z'),
    });
    return { agente, bitacora, peticiones };
  }

  it('«¿puedo pagar con tarjeta?» llega al proveedor y no queda bloqueada', async () => {
    const { agente, bitacora, peticiones } = armar();
    await agente.responder({ conversacionId: 'conv_00000101', texto: '¿puedo pagar con tarjeta?', canal: 'web' });
    expect(peticiones.length).toBeGreaterThan(0);
    expect(bitacora.eventos.some((e) => e.tipo === 'entrada_bloqueada')).toBe(false);
  });

  it('«el cvv de mi tarjeta es 123» se bloquea antes del proveedor y la bitácora no guarda el texto', async () => {
    const { agente, bitacora, peticiones } = armar();
    const texto = 'el cvv de mi tarjeta es 123';
    const r = await agente.responder({ conversacionId: 'conv_00000102', texto, canal: 'web' });
    expect(r.texto).toBe(config.mensajes.entradaBloqueada);
    expect(peticiones).toHaveLength(0);
    const evento = bitacora.eventos.find((e) => e.tipo === 'entrada_bloqueada');
    expect(evento).toMatchObject({ avisos: expect.arrayContaining(['entrada:tarjeta']) });
    expect(JSON.stringify(bitacora.eventos)).not.toContain(texto);
    expect(JSON.stringify(bitacora.eventos)).not.toContain('123');
  });
});
