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

export type MotivoRechazo = 'no_habilitado' | 'valor_no_booleano' | 'campo_ausente' | 'registro_invalido';

export interface RegistroRechazado {
  indice: number;
  motivo: MotivoRechazo;
}

export interface ConteoHabilitados {
  total: number;
  habilitados: number;
  rechazados: number;
  porMotivo: Record<MotivoRechazo, number>;
}

export interface SeparacionRegistros {
  habilitados: Record<string, unknown>[];
  rechazados: RegistroRechazado[];
  conteo: ConteoHabilitados;
}

const CAMPO = 'habilitado_produccion';

function esObjetoPlano(valor: unknown): valor is Record<string, unknown> {
  if (typeof valor !== 'object' || valor === null || Array.isArray(valor) || types.isProxy(valor)) return false;
  const proto: unknown = Object.getPrototypeOf(valor);
  return proto === Object.prototype || proto === null;
}

export function separarRegistrosHabilitados(registros: unknown): SeparacionRegistros {
  const habilitados: Record<string, unknown>[] = [];
  const rechazados: RegistroRechazado[] = [];
  const porMotivo: Record<MotivoRechazo, number> = {
    no_habilitado: 0,
    valor_no_booleano: 0,
    campo_ausente: 0,
    registro_invalido: 0,
  };
  const rechazar = (indice: number, motivo: MotivoRechazo): void => {
    rechazados.push({ indice, motivo });
    porMotivo[motivo] += 1;
  };

  if (!Array.isArray(registros) || types.isProxy(registros)) {
    // Entrada no válida en su conjunto: un único rechazo sin índice real (-1).
    rechazar(-1, 'registro_invalido');
    return { habilitados, rechazados, conteo: { total: 0, habilitados: 0, rechazados: 1, porMotivo } };
  }

  const n = registros.length;
  for (let i = 0; i < n; i++) {
    const registro: unknown = registros[i];
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
      habilitados.push(structuredClone(registro));
    } else if (d.value === false) {
      rechazar(i, 'no_habilitado');
    } else {
      rechazar(i, 'valor_no_booleano');
    }
  }

  return {
    habilitados,
    rechazados,
    conteo: { total: n, habilitados: habilitados.length, rechazados: rechazados.length, porMotivo },
  };
}
