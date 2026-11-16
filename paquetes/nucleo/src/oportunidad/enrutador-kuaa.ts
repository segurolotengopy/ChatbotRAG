/**
 * ENRUTADOR CONECTADO A KUAA (modelo híbrido, H4d)
 *
 * Por qué existe: une las piezas puras de H2 a H4c (decisión de carril, semántica, textos fijos con D5) con el agente
 * Kuaa. Este módulo solo DECIDE el carril de un mensaje (con el embedding de la consulta, su tope de tiempo y la
 * aptitud de la calibración) y arma el verificador de salida propio de Kuaa; quien responde sigue siendo
 * `agente-kuaa.ts`.
 *
 * Defecto que motiva el control: una respuesta fija o una derivación salen SIN pasar por el modelo, así que no pueden
 * apoyarse en las verificaciones que hoy hacen sus filtros (enlaces, precios, tratamiento tributario, hechos no
 * respaldados, fuga del prompt). `verificadorKuaa` las reúne para que el texto aprobado pase por las mismas, y un texto
 * que no pasa se descarta (D5), no se corrige. Además, la semántica se usa SOLO si la calibración es apta con el modelo
 * y la dimensión REALES del embebedor; cualquier fallo (embebedor, tiempo, dimensión, calibración) cae a la IA de
 * siempre con un motivo enumerado, jamás a una respuesta fija.
 *
 * Una sola llamada de embedding por mensaje: el embebedor que se entrega es el mismo (con memoria) que usa el índice del
 * RAG, y la consulta es el mismo texto, de modo que el segundo pedido reutiliza el vector.
 *
 * Qué NO garantiza: que el banco sea correcto (lo aprueba su `aprobado_por`); que la bandera de entorno se haya
 * encendido en el ambiente correcto; recargar el banco en caliente; ni la aclaración «¿sobre qué plan?» (D3). D10 (un término de
 * emergencia gana sobre una entrada bloqueada, decisión de Andres del 2026-11-07) lo resuelve `emergencia()`: solo la vía exacta
 * de términos de emergencia, sin embedding ni semántica; no cubre emergencias que el banco no nombre con un término.
 */
import type { Enrutador } from '../configuracion/esquema.js';
import type { Calibracion } from '../banco/calibracion.js';
import { verificarCalibracion } from '../banco/calibracion.js';
import { buscarEmergencia } from '../banco/enrutador.js';
import type { DecisionDerivacion, EstadoEnrutador, IndiceEnrutador } from '../banco/enrutador.js';
import { consultarEmbedding } from '../banco/embebedor-memo.js';
import { enrutarConSemantica } from '../banco/enrutador-semantico.js';
import type { ContextoSemantico, ResultadoEnrutamiento } from '../banco/enrutador-semantico.js';
import type { IndiceSemantico } from '../banco/similitud.js';
import type { VerificadorAdicional } from '../banco/texto-fijo.js';
import type { Embebedor } from '../puertos/proveedor-llm.js';
import type { EstadosOperativos, Plataforma } from './esquemas.js';
import { patronEnlaceOPrecio, permitidosDe } from './detector-enlace-precio.js';
import { extraerMarcas } from '../compuertas/salida.js';
import {
  afirmaHechoNoRespaldado,
  afirmaTratamientoTributario,
  filtraPrompt,
  quitarPromesasDeEntrega,
  quitarSaludoInicial,
  retirarCodigosInternos,
  retirarNumerosDeRegistro,
} from './salida-kuaa.js';

/** Tope de espera del embedding de la consulta: pasado este tiempo el mensaje sigue por la IA. */
export const TOPE_EMBEDDING_MS = 1500;

/** Valores de `CHATBOTRAG_ENRUTADOR` que encienden el enrutador (`apagado` o ausente = no se construye nada). */
export type ModoEnrutadorKuaa = 'activo' | 'activo_fijo';

export interface OpcionesEnrutadorKuaa {
  modo: ModoEnrutadorKuaa;
  /** Banco ya cargado y verificado (H4c). */
  indice: IndiceEnrutador;
  calibracion: Calibracion | null;
  /** Índice semántico preparado con `embebedor`; `null` si no se pudo preparar. */
  indiceSemantico: IndiceSemantico | null;
  /** El MISMO embebedor (con memoria) que usa el RAG; `null` con el proveedor simulado. */
  embebedor: Embebedor | null;
  /** Solo pruebas: admite una calibración medida con el proveedor simulado. */
  admitirSimulado?: boolean;
  topeEmbeddingMs?: number;
}

export class EnrutadorKuaa {
  readonly indice: IndiceEnrutador;
  private readonly config: Enrutador;
  private readonly semantica: ContextoSemantico | null;
  private readonly semanticaApta: boolean;
  private readonly embebedor: Embebedor | null;
  private readonly tope: number;

  /** `config` es el bloque `enrutador` de la configuración; `activo_fijo` solo enciende el carril fijo si la config lo declara. */
  constructor(opciones: OpcionesEnrutadorKuaa, config: Enrutador) {
    this.indice = opciones.indice;
    this.embebedor = opciones.embebedor;
    this.tope = opciones.topeEmbeddingMs ?? TOPE_EMBEDDING_MS;
    this.config = { activo: config.activo, carrilFijo: config.activo && config.carrilFijo && opciones.modo === 'activo_fijo' };
    const s = opciones.indiceSemantico;
    const e = opciones.embebedor;
    const cal = opciones.calibracion;
    // El índice debe haberse construido con ESTE embebedor: el modelo y la dimensión de la calibración se comparan con los reales.
    this.semantica =
      s !== null && e !== null && cal !== null && s.modelo === e.nombre && s.dimension === e.dimension
        ? { indice: s, calibracion: cal, ...(opciones.admitirSimulado === undefined ? {} : { admitirSimulado: opciones.admitirSimulado }) }
        : null;
    this.semanticaApta =
      this.semantica !== null &&
      opciones.indice.bancoSha256 !== null &&
      verificarCalibracion(this.semantica.calibracion, {
        bancoSha256: opciones.indice.bancoSha256,
        modelo: this.semantica.indice.modelo,
        dimension: this.semantica.indice.dimension,
        ...(opciones.admitirSimulado === undefined ? {} : { admitirSimulado: opciones.admitirSimulado }),
      }).semanticaApta;
  }

  /**
   * D10: coincidencia exacta con un término de emergencia del banco, para un mensaje que la compuerta de entrada bloqueó.
   * Sin embedding, sin semántica, sin calibración (por eso la calibración no apta no la afecta) y sin `carrilFijo`.
   */
  emergencia(texto: string): DecisionDerivacion | null {
    return buscarEmergencia(texto, this.indice);
  }

  /**
   * Decide el carril. Primero sin embedding (coincidencia exacta, que no lo necesita); solo si queda
   * `semantica_no_disponible` y la calibración es apta se calcula el vector de la consulta y se decide de nuevo.
   * `sinEmbedding` (una cortesía) salta la vía semántica sin gastar la llamada.
   */
  async decidir(texto: string, estado: EstadoEnrutador, sinEmbedding = false): Promise<{ resultado: ResultadoEnrutamiento; latenciaMs: number }> {
    const inicio = performance.now();
    let resultado = enrutarConSemantica(texto, this.indice, this.config, estado, this.semantica, null);
    const d = resultado.decision;
    if (!sinEmbedding && this.semanticaApta && this.embebedor !== null && resultado.via === 'semantica' && d.carril === 'ia' && d.motivo === 'semantica_no_disponible') {
      const consulta = await consultarEmbedding(this.embebedor, texto, this.tope);
      resultado = enrutarConSemantica(texto, this.indice, this.config, estado, this.semantica, consulta);
    }
    return { resultado, latenciaMs: performance.now() - inicio };
  }
}

/**
 * Verificador de los textos fijos y de derivación: las mismas comprobaciones que Kuaa aplica a la salida del modelo y, además,
 * que ningún retoque de esa salida cambie un texto APROBADO: una marca literal del modelo (`[DERIVAR]`), un código interno, una
 * promesa de entrega, un número de registro o un saludo inicial lo harían distinto de lo que aprobó el banco, así que el
 * texto se descarta (D5), no se corrige. Los códigos devueltos son enumerados cortos; nunca llevan texto.
 */
export function verificadorKuaa(plataforma: Plataforma | undefined, estados: EstadosOperativos, marcasLiterales: readonly string[] = []): VerificadorAdicional {
  const permitidos = permitidosDe(plataforma);
  return (texto) => {
    if (patronEnlaceOPrecio(texto, permitidos) !== null) return 'enlace_o_precio';
    if (afirmaTratamientoTributario(texto)) return 'tributario';
    if (afirmaHechoNoRespaldado(texto, estados) !== null) return 'hecho_no_respaldado';
    if (filtraPrompt(texto)) return 'fuga_prompt';
    // Sin marcas permitidas: cualquier marca (incluso una declarada, como DERIVAR) es del modelo y no va en un texto aprobado.
    if (extraerMarcas(texto, [], marcasLiterales).borradas > 0) return 'marca_del_modelo';
    if (retirarCodigosInternos(texto) !== texto) return 'codigo_interno';
    if (quitarPromesasDeEntrega(texto) !== texto) return 'promesa_entrega';
    if (retirarNumerosDeRegistro(texto) !== texto) return 'numero_registro';
    if (quitarSaludoInicial(texto, '', false, 0) !== texto) return 'saludo_inicial';
    return null;
  };
}
