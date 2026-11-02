/**
 * LECTOR DEL PAQUETE DE CONOCIMIENTO EN GOOGLE CLOUD STORAGE
 *
 * Porqué: el paquete de conocimiento no validado de Kuaa vive en un bucket privado, FUERA del repo público y
 * de la imagen, y el servicio lo lee al arrancar con su propia identidad (ADC; ninguna clave en el código ni
 * en el entorno). Este paquete es el único que importa `@google-cloud/storage` (frontera de nube).
 *
 * Layout: `gs://<bucket>/<version>/manifiesto.json` y los archivos que el manifiesto lista. Solo lee: no
 * crea, no modifica, no borra. Cada archivo se verifica contra los `bytes` (metadatos y descarga) y el SHA-256
 * del manifiesto: otro tamaño u otra huella invalida la lectura (`INTEGRIDAD`). Un 403 o un 404 se convierten en un error
 * tipado (`ErrorPaqueteGcs`) cuyo mensaje NO incluye el nombre del bucket ni de la ruta.
 *
 * Qué NO garantiza: que la huella del manifiesto sea honesta (quien escribe el bucket escribe ambos); la
 * integridad frente a un atacante con escritura se protege con el IAM del bucket, no con este código.
 */
import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { esquemaManifiestoPaquete, type LectorPaquete, type ManifiestoPaquete } from '@chatbotrag/nucleo';

export type CodigoErrorPaquete = 'NO_AUTORIZADO' | 'NO_ENCONTRADO' | 'INTEGRIDAD' | 'MANIFIESTO' | 'VERSION' | 'ERROR';

export class ErrorPaqueteGcs extends Error {
  constructor(public readonly codigo: CodigoErrorPaquete) {
    super(`No se pudo leer el paquete de conocimiento (${codigo})`);
    this.name = 'ErrorPaqueteGcs';
  }
}

/** Costura mínima sobre el cliente de GCS: descarga un objeto del bucket ya fijado. */
export interface ClienteObjetos {
  /** Tamaño y generación según los metadatos del objeto, SIN descargarlo. */
  metadatos(rutaObjeto: string): Promise<{ tamano: number; generacion: string }>;
  /** Descarga EXACTAMENTE esa generación: si el objeto se reemplaza entre la consulta y la descarga, falla. */
  descargar(rutaObjeto: string, generacion: string): Promise<Buffer>;
}

/** Tope del manifiesto: se consulta su tamaño antes de bajarlo. */
export const TOPE_BYTES_MANIFIESTO = 256 * 1024;

export function crearClienteGcs(bucket: string): ClienteObjetos {
  const b = new Storage().bucket(bucket);
  return {
    async metadatos(rutaObjeto) {
      const [m] = await b.file(rutaObjeto).getMetadata();
      return { tamano: Number(m.size), generacion: String(m.generation) };
    },
    async descargar(rutaObjeto, generacion) {
      const [contenido] = await b.file(rutaObjeto, { generation: generacion }).download();
      return contenido;
    },
  };
}

function traducir(e: unknown): ErrorPaqueteGcs {
  if (e instanceof ErrorPaqueteGcs) return e;
  const codigo = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  if (codigo === 403 || codigo === 401) return new ErrorPaqueteGcs('NO_AUTORIZADO');
  if (codigo === 404) return new ErrorPaqueteGcs('NO_ENCONTRADO');
  return new ErrorPaqueteGcs('ERROR');
}

export class LectorPaqueteGcs implements LectorPaquete {
  private manifiesto: ManifiestoPaquete | null = null;
  private readonly cliente: ClienteObjetos;
  private readonly version: string;

  constructor(opciones: { bucket: string; version: string; cliente?: ClienteObjetos }) {
    this.version = opciones.version;
    this.cliente = opciones.cliente ?? crearClienteGcs(opciones.bucket);
  }

  async leerManifiesto(): Promise<ManifiestoPaquete> {
    let crudo: Buffer;
    try {
      const ruta = `${this.version}/manifiesto.json`;
      const m = await this.cliente.metadatos(ruta);
      if (!(m.tamano <= TOPE_BYTES_MANIFIESTO)) throw new ErrorPaqueteGcs('MANIFIESTO');
      crudo = await this.cliente.descargar(ruta, m.generacion);
      if (crudo.length > TOPE_BYTES_MANIFIESTO) throw new ErrorPaqueteGcs('MANIFIESTO');
    } catch (e) {
      throw traducir(e);
    }
    let analizado: unknown;
    try {
      analizado = JSON.parse(crudo.toString('utf8'));
    } catch {
      throw new ErrorPaqueteGcs('MANIFIESTO');
    }
    const r = esquemaManifiestoPaquete.safeParse(analizado);
    if (!r.success) throw new ErrorPaqueteGcs('MANIFIESTO');
    if (r.data.version !== this.version) throw new ErrorPaqueteGcs('VERSION');
    this.manifiesto = r.data;
    return r.data;
  }

  async leer(rutaRelativa: string): Promise<string> {
    const entrada = this.manifiesto?.archivos.find((a) => a.ruta === rutaRelativa);
    // Sin manifiesto leído, o fuera de él, o sin huella: no se lee nada.
    if (!entrada) throw new ErrorPaqueteGcs('INTEGRIDAD');
    let contenido: Buffer;
    try {
      // El tamaño declarado se contrasta con los metadatos ANTES de descargar: un objeto más grande no se baja.
      const ruta = `${this.version}/${rutaRelativa}`;
      const m = await this.cliente.metadatos(ruta);
      if (m.tamano !== entrada.bytes) throw new ErrorPaqueteGcs('INTEGRIDAD');
      // Se baja la generación que se midió, no «la última»: evita un cambio entre la consulta y la descarga.
      contenido = await this.cliente.descargar(ruta, m.generacion);
    } catch (e) {
      throw traducir(e);
    }
    if (contenido.length !== entrada.bytes) throw new ErrorPaqueteGcs('INTEGRIDAD');
    if (createHash('sha256').update(contenido).digest('hex') !== entrada.sha256) throw new ErrorPaqueteGcs('INTEGRIDAD');
    return contenido.toString('utf8');
  }
}
