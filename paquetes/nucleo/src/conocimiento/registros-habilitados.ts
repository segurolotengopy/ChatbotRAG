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
 * responsable (Rodrigo) lo haya revisado; solo lee una bandera booleana.
 */

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
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
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
  const lista: unknown[] = Array.isArray(registros) ? registros : [];

  const rechazar = (indice: number, motivo: MotivoRechazo): void => {
    rechazados.push({ indice, motivo });
    porMotivo[motivo] += 1;
  };

  if (!Array.isArray(registros)) {
    // Entrada no válida en su conjunto: un único rechazo sin índice real (-1).
    rechazar(-1, 'registro_invalido');
  }

  lista.forEach((registro, indice) => {
    if (!esObjetoPlano(registro)) return rechazar(indice, 'registro_invalido');
    if (!Object.prototype.hasOwnProperty.call(registro, CAMPO)) return rechazar(indice, 'campo_ausente');
    const valor = registro[CAMPO];
    if (valor === true) {
      habilitados.push(registro);
      return;
    }
    if (valor === false) return rechazar(indice, 'no_habilitado');
    return rechazar(indice, 'valor_no_booleano');
  });

  return {
    habilitados,
    rechazados,
    conteo: {
      total: lista.length,
      habilitados: habilitados.length,
      rechazados: rechazados.length,
      porMotivo,
    },
  };
}
