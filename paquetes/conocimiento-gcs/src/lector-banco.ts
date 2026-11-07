/**
 * LECTOR DEL BANCO DE RESPUESTAS Y DE SU CALIBRACIÓN EN GOOGLE CLOUD STORAGE (modelo híbrido, H4c)
 *
 * Porqué: el banco aprobado (`banco.json`) y su calibración (`calibracion.json`) viven en un bucket privado, fuera
 * del repo público y de la imagen. Layout: `<agenteId>/<X.Y.Z>/banco.json` y `calibracion.json`. El servicio declara en
 * `CHATBOTRAG_BANCOS` la versión y el SHA-256 esperado de cada archivo; este lector verifica la huella de los bytes
 * ANTES de interpretarlos y recién entonces los pasa a `cargarBanco` y `cargarCalibracion` del núcleo.
 *
 * Defecto que motiva el control: el contenido del bucket es dato no confiable. Un banco cambiado, truncado, enorme o
 * sintético llegaría al cliente con la autoridad de «texto aprobado». Por eso: tope de tamaño consultado en los
 * metadatos antes de descargar, descarga de esa generación exacta, SHA-256 obligatorio, parseo estricto y ningún
 * `eval`. Solo lee: no crea, no modifica, no borra.
 *
 * Comportamiento ante fallos: NUNCA lanza. Un banco ausente, ilegible, demasiado grande, con otra huella o inválido
 * deja el resultado sin enrutador (`indice: null`) y con un motivo enumerado; el servicio sigue con el comportamiento
 * actual. Una calibración inválida o no apta se ignora (el banco queda con coincidencia exacta). Los motivos son
 * enumerados: jamás llevan texto del contenido, rutas ni nombres del bucket.
 *
 * Qué NO garantiza: que la huella declarada sea la correcta (la fija quien despliega); la verificación de modelo y
 * dimensión de la calibración (la hace H4d, cuando exista el embebedor: aquí solo se comprueba que corresponda al
 * banco cargado, a la regla vigente y que sea válida); que alguien con escritura en el bucket no pueda reemplazar
 * ambos archivos y la variable (eso lo protege el IAM).
 */
import { createHash } from 'node:crypto';
import {
  type Calibracion,
  type IndiceEnrutador,
  ErrorBanco,
  VERSION_REGLA_DECISION,
  cargarBanco,
  cargarCalibracion,
  prepararEnrutador,
} from '@chatbotrag/nucleo';
import { type ClienteObjetos, crearClienteGcs } from './lector.js';

export const TOPE_BYTES_BANCO = 2 * 1024 * 1024;
export const TOPE_BYTES_CALIBRACION = 64 * 1024;

export const MOTIVOS_BANCO = [
  'banco_no_autorizado',
  'banco_ausente',
  'banco_error',
  'banco_tiempo',
  'banco_demasiado_grande',
  'banco_sha_distinto',
  'banco_invalido',
  'banco_sintetico',
] as const;
export const MOTIVOS_CALIBRACION = [
  'calibracion_no_declarada',
  'calibracion_no_autorizada',
  'calibracion_ausente',
  'calibracion_error',
  'calibracion_demasiado_grande',
  'calibracion_sha_distinto',
  'calibracion_invalida',
  'calibracion_no_apta',
] as const;
export type MotivoBanco = (typeof MOTIVOS_BANCO)[number] | (typeof MOTIVOS_CALIBRACION)[number];

export interface DeclaracionBanco {
  version: string;
  sha256: string;
  sha256Calibracion?: string | undefined;
}

export interface ResultadoBancoGcs {
  /** Enrutador listo, o `null` si el banco no se pudo cargar. */
  indice: IndiceEnrutador | null;
  /** Calibración leída y coherente con el banco, o `null` (solo coincidencia exacta). */
  calibracion: Calibracion | null;
  /** Ausente si todo cargó. Si hay `indice: null` es el motivo del banco; si no, el de la calibración. */
  motivo?: MotivoBanco;
}

class ErrorLectura extends Error {
  constructor(public readonly causa: 'autorizacion' | 'ausente' | 'error' | 'grande') {
    super(`No se pudo leer el objeto (${causa})`);
    this.name = 'ErrorLectura';
  }
}

function causaDe(e: unknown): ErrorLectura {
  if (e instanceof ErrorLectura) return e;
  const codigo = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (codigo === 403 || codigo === 401) return new ErrorLectura('autorizacion');
  if (codigo === 404) return new ErrorLectura('ausente');
  return new ErrorLectura('error');
}

const sha256De = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

export class LectorBancoGcs {
  private readonly cliente: ClienteObjetos;

  constructor(opciones: { bucket: string; cliente?: ClienteObjetos }) {
    this.cliente = opciones.cliente ?? crearClienteGcs(opciones.bucket);
  }

  private async leerObjeto(ruta: string, tope: number): Promise<Buffer> {
    try {
      const m = await this.cliente.metadatos(ruta);
      if (!(m.tamano <= tope)) throw new ErrorLectura('grande');
      const contenido = await this.cliente.descargar(ruta, m.generacion);
      if (contenido.length > tope) throw new ErrorLectura('grande');
      return contenido;
    } catch (e) {
      throw causaDe(e);
    }
  }

  async cargar(agenteId: string, declaracion: DeclaracionBanco, opciones: { admitirSintetico: boolean }): Promise<ResultadoBancoGcs> {
    const base = `${agenteId}/${declaracion.version}`;

    // 1. Banco: sin él no hay enrutador.
    let crudoBanco: Buffer;
    try {
      crudoBanco = await this.leerObjeto(`${base}/banco.json`, TOPE_BYTES_BANCO);
    } catch (e) {
      const causa = causaDe(e).causa;
      const motivo: MotivoBanco = causa === 'autorizacion' ? 'banco_no_autorizado' : causa === 'ausente' ? 'banco_ausente' : causa === 'grande' ? 'banco_demasiado_grande' : 'banco_error';
      return { indice: null, calibracion: null, motivo };
    }
    if (sha256De(crudoBanco) !== declaracion.sha256.toLowerCase()) return { indice: null, calibracion: null, motivo: 'banco_sha_distinto' };
    let indice: IndiceEnrutador;
    let bancoSha256: string;
    try {
      const cargado = cargarBanco(crudoBanco.toString('utf8'), { sha256Esperado: declaracion.sha256, admitirSintetico: opciones.admitirSintetico });
      bancoSha256 = cargado.sha256;
      indice = prepararEnrutador(cargado.banco, cargado.sha256);
    } catch (e) {
      // Solo se conserva la distinción enumerada (`codigo`), jamás el mensaje ni los detalles.
      const sintetico = e instanceof ErrorBanco && e.codigo === 'sintetico';
      return { indice: null, calibracion: null, motivo: sintetico ? 'banco_sintetico' : 'banco_invalido' };
    }

    // 2. Calibración: opcional y nunca bloquea al banco.
    if (declaracion.sha256Calibracion === undefined) return { indice, calibracion: null, motivo: 'calibracion_no_declarada' };
    let crudoCal: Buffer;
    try {
      crudoCal = await this.leerObjeto(`${base}/calibracion.json`, TOPE_BYTES_CALIBRACION);
    } catch (e) {
      const causa = causaDe(e).causa;
      const motivo: MotivoBanco = causa === 'autorizacion' ? 'calibracion_no_autorizada' : causa === 'ausente' ? 'calibracion_ausente' : causa === 'grande' ? 'calibracion_demasiado_grande' : 'calibracion_error';
      return { indice, calibracion: null, motivo };
    }
    if (sha256De(crudoCal) !== declaracion.sha256Calibracion.toLowerCase()) return { indice, calibracion: null, motivo: 'calibracion_sha_distinto' };
    let calibracion: Calibracion;
    try {
      calibracion = cargarCalibracion(crudoCal.toString('utf8'));
    } catch {
      return { indice, calibracion: null, motivo: 'calibracion_invalida' };
    }
    // Verificación parcial: la de modelo y dimensión la completa H4d con el embebedor.
    // Una calibración medida con el proveedor simulado (sin semántica real) solo se admite en pruebas.
    if (
      calibracion.banco_sha256.toLowerCase() !== bancoSha256 ||
      calibracion.regla !== VERSION_REGLA_DECISION ||
      !calibracion.valido ||
      (calibracion.proveedor === 'simulado' && !opciones.admitirSintetico)
    ) {
      return { indice, calibracion: null, motivo: 'calibracion_no_apta' };
    }
    return { indice, calibracion };
  }
}
