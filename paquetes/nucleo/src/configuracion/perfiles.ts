/**
 * RESOLUCIÓN DE PERFILES
 *
 * Un perfil es una superposición PARCIAL sobre la configuración base. La regla de
 * fusión es simple y hay que poder explicarla en una frase: **los objetos se
 * fusionan por clave, los arreglos y los escalares se reemplazan**. Un arreglo del
 * perfil (p. ej. `alcance.temasPermitidos`) sustituye al de la base, no se
 * concatena: si se concatenaran, un perfil no podría QUITAR un tema, y quitar es
 * justamente lo que necesita un producto más restringido que la base.
 *
 * `modelo`, `id` y `version` no se superponen nunca: no son contenido, son
 * operación del servicio.
 */
import type { ConfiguracionAgente, ConfiguracionEfectiva, Perfil } from './esquema.js';

export class ErrorPerfil extends Error {
  constructor(public readonly perfilId: string) {
    super(`El perfil «${perfilId}» no existe en la configuración`);
    this.name = 'ErrorPerfil';
  }
}

type Plano = Record<string, unknown>;

function esObjetoPlano(v: unknown): v is Plano {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Fusión profunda: objetos por clave; arreglos y escalares, reemplazo. */
export function fusionar<T extends Plano>(base: T, superposicion: Plano | undefined): T {
  if (!superposicion) return base;
  const salida: Plano = { ...base };
  for (const [clave, valor] of Object.entries(superposicion)) {
    if (valor === undefined) continue;
    const previo = salida[clave];
    salida[clave] = esObjetoPlano(previo) && esObjetoPlano(valor) ? fusionar(previo, valor) : valor;
  }
  return salida as T;
}

export const SECCIONES_SUPERPONIBLES = [
  'identidad',
  'voz',
  'operacion',
  'datos',
  'alcance',
  'conocimiento',
  'seguridad',
  'herramientas',
  'orientacion',
  'mensajes',
] as const;

/**
 * Devuelve la configuración efectiva para un perfil (o la base si `perfilId` es
 * null y no hay `perfilPorDefecto`). Lanza `ErrorPerfil` si el id no existe: un
 * perfil desconocido no cae en silencio a la base, porque la base puede ser más
 * permisiva que el perfil que el cliente creía estar usando.
 */
export function resolverConfiguracion(config: ConfiguracionAgente, perfilId: string | null | undefined): ConfiguracionEfectiva {
  const idElegido = perfilId ?? config.perfilPorDefecto ?? null;
  const { perfiles, perfilPorDefecto: _omitido, ...base } = config;
  void _omitido;

  if (idElegido === null) return { ...base, perfilId: null, perfilNombre: null };

  const perfil: Perfil | undefined = perfiles[idElegido];
  if (!perfil) throw new ErrorPerfil(idElegido);

  const efectiva: Plano = { ...base };
  for (const seccion of SECCIONES_SUPERPONIBLES) {
    const superposicion = perfil[seccion];
    if (superposicion === undefined) continue;
    const previo = efectiva[seccion];
    efectiva[seccion] = esObjetoPlano(previo) && esObjetoPlano(superposicion) ? fusionar(previo, superposicion) : superposicion;
  }
  return { ...(efectiva as Omit<ConfiguracionAgente, 'perfiles' | 'perfilPorDefecto'>), perfilId: idElegido, perfilNombre: perfil.nombre };
}

/** Lista de perfiles para el cliente (selector de producto, por ejemplo). */
export function listarPerfiles(config: ConfiguracionAgente): Array<{ id: string; nombre: string; descripcion: string | null }> {
  return Object.entries(config.perfiles).map(([id, p]) => ({ id, nombre: p.nombre, descripcion: p.descripcion ?? null }));
}
