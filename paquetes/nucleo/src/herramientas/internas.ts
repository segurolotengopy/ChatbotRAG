/**
 * HERRAMIENTAS INTERNAS
 *
 * Las resuelve el núcleo sin red. Son deterministas y probables:
 *
 *  - `derivar_humano`     → marca la conversación para derivación y devuelve el contacto.
 *  - `recomendar_opcion`  → evalúa `orientacion.reglas` con las facetas conocidas. La
 *                           recomendación la decide la REGLA configurada, no el modelo:
 *                           el texto que llega a la persona sale de la configuración.
 *  - `consultar_horarios` → devuelve el horario legible (derivado).
 *
 * Una herramienta declarada en la configuración con `tipo: interna` y un nombre
 * que no está acá es un error de configuración que se detecta al cargar (ver
 * `registro.ts`), no en medio de una conversación.
 */
import { horarioLegible } from '../configuracion/derivados.js';
import type { ConfiguracionEfectiva, Herramienta } from '../configuracion/esquema.js';
import type { ContextoHerramienta, ResultadoHerramienta } from '../puertos/herramienta.js';
import type { DefinicionHerramientaLLM } from '../puertos/proveedor-llm.js';
import { normalizar } from '../compuertas/vocabulario.js';

export type FuncionInterna = (argumentos: Record<string, unknown>, ctx: ContextoHerramienta) => Promise<ResultadoHerramienta>;

const derivarHumano: FuncionInterna = async (argumentos, ctx) => {
  const motivo = typeof argumentos['motivo'] === 'string' ? argumentos['motivo'].slice(0, 120) : 'solicitud de la persona';
  const c = ctx.config.operacion.contactoHumano;
  return {
    resultado: {
      derivado: true,
      contacto: { whatsapp: c.whatsapp ?? null, telefono: c.telefono ?? null, correo: c.correo ?? null, texto: c.texto ?? null },
      indicacion: 'Informe a la persona que su consulta pasa a una persona del equipo y comparta el contacto disponible.',
    },
    derivacion: { motivo },
  };
};

/** Evalúa las reglas: gana la primera cuyas condiciones se cumplan todas, con más condiciones primero. */
export function evaluarReglas(config: ConfiguracionEfectiva, facetas: Record<string, string>): { id: string; texto: string } | null {
  const conocidas = Object.fromEntries(Object.entries(facetas).map(([k, v]) => [k, normalizar(v)]));
  const reglas = [...config.orientacion.reglas].sort((a, b) => Object.keys(b.si).length - Object.keys(a.si).length);
  for (const r of reglas) {
    const cumple = Object.entries(r.si).every(([f, v]) => conocidas[f] !== undefined && conocidas[f] === normalizar(v));
    if (cumple) return { id: r.recomendar, texto: r.texto };
  }
  return null;
}

const recomendarOpcion: FuncionInterna = async (argumentos, ctx) => {
  // Solo se aceptan facetas declaradas y valores dentro de sus opciones.
  const facetas: Record<string, string> = {};
  for (const f of ctx.config.orientacion.facetas) {
    const v = argumentos[f.id];
    if (typeof v !== 'string') continue;
    const opcion = f.opciones.find((o) => normalizar(o) === normalizar(v));
    if (opcion) facetas[f.id] = opcion;
  }
  const faltan = ctx.config.orientacion.facetas.filter((f) => !(f.id in facetas)).map((f) => f.id);
  const recomendacion = evaluarReglas(ctx.config, facetas);
  if (!recomendacion) {
    return {
      resultado: {
        recomendacion: null,
        facetasReconocidas: facetas,
        faltan,
        indicacion: faltan.length
          ? 'Faltan facetas para recomendar: pregunte por la siguiente de la lista, de a una.'
          : 'No hay una regla configurada para esta combinación: explique que necesita derivar a una persona.',
      },
    };
  }
  return {
    resultado: {
      recomendacion: recomendacion.id,
      texto: recomendacion.texto,
      aclaracion: ctx.config.orientacion.aclaracion ?? null,
      facetasReconocidas: facetas,
      indicacion: 'Transmita el texto de la recomendación tal cual y agregue la aclaración si existe.',
    },
    recomendacion,
    facetas,
  } as ResultadoHerramienta & { facetas: Record<string, string> };
};

const consultarHorarios: FuncionInterna = async (_argumentos, ctx) => {
  const horario = horarioLegible(ctx.config.operacion.horarios);
  return { resultado: { horario: horario || null, zonaHoraria: ctx.config.identidad.zonaHoraria } };
};

export const INTERNAS: Record<string, FuncionInterna> = {
  derivar_humano: derivarHumano,
  recomendar_opcion: recomendarOpcion,
  consultar_horarios: consultarHorarios,
};

/** Convierte una herramienta configurada en la definición neutral que ve el modelo. */
export function definicionPara(h: Herramienta, config: ConfiguracionEfectiva): DefinicionHerramientaLLM {
  const properties: DefinicionHerramientaLLM['parametros']['properties'] = {};
  const required: string[] = [];
  // `recomendar_opcion` toma sus parámetros de las facetas configuradas, no de la declaración.
  if (h.nombre === 'recomendar_opcion') {
    for (const f of config.orientacion.facetas) properties[f.id] = { type: 'string', description: f.pregunta, enum: f.opciones };
  } else {
    for (const [nombre, p] of Object.entries(h.parametros)) {
      properties[nombre] = { type: p.tipo, description: p.descripcion, ...(p.opciones ? { enum: p.opciones } : {}) };
      if (p.requerido) required.push(nombre);
    }
  }
  return {
    nombre: h.nombre,
    descripcion: h.descripcion,
    parametros: { type: 'object', properties, ...(required.length ? { required } : {}) },
  };
}
