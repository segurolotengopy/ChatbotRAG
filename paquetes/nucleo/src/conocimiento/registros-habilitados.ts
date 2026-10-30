/**
 * SEPARACIÓN DE REGISTROS HABILITADOS PARA PRODUCCIÓN
 *
 * Porqué: a Kuaa solo se carga conocimiento cuya bandera `habilitado_produccion` es
 * EXACTAMENTE el booleano `true`. `estado_validacion` y `aprobacion` no habilitan nada:
 * son metadatos de revisión, no una decisión de publicar. Falla cerrado: «true» como
 * texto, 1, «si», null o la ausencia del campo NO habilitan.
 *
 * Es una función pura y no lanza: una entrada que no es arreglo, o un registro que no
 * es objeto, se informa como rechazado. Del registro rechazado solo se devuelven el
 * índice y el motivo; jamás su contenido (puede traer datos que no deben registrarse).
 *
 * Dos perfiles. `produccion` (por omisión) solo deja pasar `habilitado_produccion === true`. `pruebas`
 * deja pasar además los `false` que traen la marca literal `validacion: "no_validado"` y un
 * `version_paquete` con forma X.Y.Z; esos salen con `estado: 'no_validado'` en una unión discriminada
 * y JAMÁS en el resultado de `produccion`, cuyo tipo ni siquiera los admite. Un registro no validado
 * nunca debe poder confundirse con uno habilitado. Un registro `true` que además trae
 * `validacion: "no_validado"` es una contradicción y se rechaza en ambos perfiles
 * (`registro_contradictorio`).
 *
 * Qué NO garantiza: no valida la veracidad del contenido ni que la persona
 * responsable del contenido de SLT lo haya revisado; solo lee una bandera booleana.
 *
 * Defensas: acepta solo objetos planos (prototipo `Object.prototype` o `null`; no Date, Map,
 * clases ni Proxy); lee la bandera con `getOwnPropertyDescriptor` y exige un valor de datos
 * `true` (un getter no habilita, porque podría cambiar entre la lectura y el uso); recorre por
 * índice, de modo que los huecos de un arreglo disperso cuentan como `registro_invalido`; y
 * devuelve copias profundas de los habilitados, así una mutación posterior de la entrada no los
 * altera. Si el JSON de origen repite una clave, JSON.parse conserva la última: esa es la que
 * se evalúa.
 */
import { types } from 'node:util';

export type PerfilValidacion = 'produccion' | 'pruebas';

export type MotivoRechazo =
  | 'no_habilitado'
  | 'valor_no_booleano'
  | 'campo_ausente'
  | 'registro_invalido'
  | 'sin_marca_no_validado'
  | 'version_invalida'
  | 'registro_contradictorio';

export interface RegistroRechazado {
  indice: number;
  motivo: MotivoRechazo;
}

export type RegistroPlano = Record<string, unknown>;

/** Registro con `habilitado_produccion === true`. */
export interface RegistroHabilitado {
  estado: 'habilitado';
  registro: RegistroPlano;
}

/** Registro `false` con marca `no_validado` y versión de paquete; solo lo devuelve el perfil `pruebas`. */
export interface RegistroNoValidado {
  estado: 'no_validado';
  version_paquete: string;
  registro: RegistroPlano;
}

export type RegistroAceptado = RegistroHabilitado | RegistroNoValidado;

export interface ConteoHabilitados {
  total: number;
  /** Solo los `habilitado_produccion === true`; los no validados se cuentan aparte. */
  habilitados: number;
  /** Habilitados más no validados (en `produccion` es igual a `habilitados`). */
  aceptados: number;
  rechazados: number;
  porMotivo: Record<MotivoRechazo, number>;
  porEstado: Record<RegistroAceptado['estado'], number>;
}

export interface SeparacionProduccion {
  perfil: 'produccion';
  /** Registros planos (copias) con `habilitado_produccion === true`. Nunca un no validado. */
  habilitados: RegistroPlano[];
  rechazados: RegistroRechazado[];
  conteo: ConteoHabilitados;
}

export interface SeparacionPruebas {
  perfil: 'pruebas';
  /** Cada uno con su estado visible; discriminar por `estado`. */
  aceptados: RegistroAceptado[];
  rechazados: RegistroRechazado[];
  conteo: ConteoHabilitados;
}

export type SeparacionRegistros = SeparacionProduccion | SeparacionPruebas;

const CAMPO = 'habilitado_produccion';
const MARCA = 'no_validado';
const RE_VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function esObjetoPlano(valor: unknown): valor is RegistroPlano {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor) || types.isProxy(valor)) return false;
  const proto: unknown = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

/** Valor de datos propio de un campo (sin getters); `undefined` si falta o es un accesor. */
function valorPropio(registro: RegistroPlano, campo: string): unknown {
  const d = Object.getOwnPropertyDescriptor(registro, campo);
  return d && 'value' in d ? (d.value as unknown) : undefined;
}

export function separarRegistrosHabilitados(registros: unknown): SeparacionProduccion;
export function separarRegistrosHabilitados(registros: unknown, perfil: 'produccion'): SeparacionProduccion;
export function separarRegistrosHabilitados(registros: unknown, perfil: 'pruebas'): SeparacionPruebas;
export function separarRegistrosHabilitados(registros: unknown, perfil: PerfilValidacion): SeparacionRegistros;
export function separarRegistrosHabilitados(registros: unknown, perfil: PerfilValidacion = 'produccion'): SeparacionRegistros {
  const aceptados: RegistroAceptado[] = [];
  const rechazados: RegistroRechazado[] = [];
  const porMotivo: Record<MotivoRechazo, number> = {
    no_habilitado: 0,
    valor_no_booleano: 0,
    campo_ausente: 0,
    registro_invalido: 0,
    sin_marca_no_validado: 0,
    version_invalida: 0,
    registro_contradictorio: 0,
  };
  const rechazar = (indice: number, motivo: MotivoRechazo): void => {
    rechazados.push({ indice, motivo });
    porMotivo[motivo] += 1;
  };

  const lista: unknown[] = Array.isArray(registros) && !types.isProxy(registros) ? registros : [];
  if (lista !== registros) rechazar(-1, 'registro_invalido'); // entrada no válida en su conjunto: un único rechazo sin índice real

  const n = lista.length;
  for (let i = 0; i < n; i++) {
    const registro: unknown = lista[i];
    if (!esObjetoPlano(registro)) {
      rechazar(i, 'registro_invalido');
      continue;
    }
    const d = Object.getOwnPropertyDescriptor(registro, CAMPO);
    if (d === undefined) {
      rechazar(i, 'campo_ausente');
    } else if (!('value' in d)) {
      rechazar(i, 'valor_no_booleano');
    } else if (d.value === true) {
      // Contradicción de datos: habilitado y a la vez marcado no validado. Falla cerrado en ambos perfiles.
      if (valorPropio(registro, 'validacion') === MARCA) rechazar(i, 'registro_contradictorio');
      else aceptados.push({ estado: 'habilitado', registro: structuredClone(registro) });
    } else if (d.value === false) {
      if (perfil === 'produccion') {
        rechazar(i, 'no_habilitado');
      } else if (valorPropio(registro, 'validacion') !== MARCA) {
        rechazar(i, 'sin_marca_no_validado');
      } else {
        const version = valorPropio(registro, 'version_paquete');
        if (typeof version !== 'string' || !RE_VERSION.test(version)) rechazar(i, 'version_invalida');
        else aceptados.push({ estado: 'no_validado', version_paquete: version, registro: structuredClone(registro) });
      }
    } else {
      rechazar(i, 'valor_no_booleano');
    }
  }

  const porEstado = {
    habilitado: aceptados.filter((a) => a.estado === 'habilitado').length,
    no_validado: aceptados.filter((a) => a.estado === 'no_validado').length,
  };
  const conteo: ConteoHabilitados = { total: n, habilitados: porEstado.habilitado, aceptados: aceptados.length, rechazados: rechazados.length, porMotivo, porEstado };
  if (perfil === 'pruebas') return { perfil, aceptados, rechazados, conteo };
  return { perfil, habilitados: aceptados.map((a) => a.registro), rechazados, conteo };
}
