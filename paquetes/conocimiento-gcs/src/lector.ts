/**
 * LECTOR DEL PAQUETE DE CONOCIMIENTO EN GOOGLE CLOUD STORAGE
 *
 * Porqué: el paquete de conocimiento no validado de Kuaa vive en un bucket privado, FUERA del repo público y
 * de la imagen, y el servicio lo lee al arrancar con su propia identidad (ADC; ninguna clave en el código ni
 * en el entorno). Este paquete es el único que importa `@google-cloud/storage` (frontera de nube).
 *
 * Layout: `gs://<bucket>/<version>/manifiesto.json` y los archivos que el manifiesto lista. Solo lee: no
 * crea, no modifica, no borra. Cada archivo se verifica contra el SHA-256 del manifiesto: un archivo sin
 * huella, o con otra, invalida la lectura (`INTEGRIDAD`). Un 403 o un 404 se convierten en un error
 * tipado (`ErrorPaqueteGcs`) cuyo mensaje NO incluye el nombre del bucket ni de la ruta.
 *
 * Qué NO garantiza: que la huella del manifiesto sea honesta (quien escribe el bucket escribe ambos); la
 * integridad frente a un atacante con escritura se protege con el IAM del bucket, no con este código.
 */
import { createHash } from 'node:crypto';
import { Storage } from '@google-cloud/storage';
import { esquemaManifiestoPaquete, type LectorPaquete, type ManifiestoPaquete } from '@chatbotrag/nucleo';

export type CodigoErrorPaquete = 'NO_AUTORIZADO' | 'NO_ENCONTRADO' | 'INTEGRIDAD' | 'MANIFIESTO' | 'ERROR';

export class ErrorPaqueteGcs extends Error {
  constructor(public readonly codigo: CodigoErrorPaquete) {
    super(`No se pudo leer el paquete de conocimiento (${codigo})`);
    this.name = 'ErrorPaqueteGcs';
  }
}

/** Costura mínima sobre el cliente de GCS: descarga un objeto del bucket ya fijado. */
export interface ClienteObjetos {
  descargar(rutaObjeto: string): Promise<Buffer>;
}

export function crearClienteGcs(bucket: string): ClienteObjetos {
  const b = new Storage().bucket(bucket);
  return {
    async descargar(rutaObjeto) {
      const [contenido] = await b.file(rutaObjeto).download();
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
      crudo = await this.cliente.descargar(`${this.version}/manifiesto.json`);
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
    this.manifiesto = r.data;
    return r.data;
  }

  async leer(rutaRelativa: string): Promise<string> {
    const entrada = this.manifiesto?.archivos.find((a) => a.ruta === rutaRelativa);
    // Sin manifiesto leído, o fuera de él, o sin huella: no se lee nada.
    if (!entrada?.sha256) throw new ErrorPaqueteGcs('INTEGRIDAD');
    let contenido: Buffer;
    try {
      contenido = await this.cliente.descargar(`${this.version}/${rutaRelativa}`);
    } catch (e) {
      throw traducir(e);
    }
    if (createHash('sha256').update(contenido).digest('hex') !== entrada.sha256) throw new ErrorPaqueteGcs('INTEGRIDAD');
    return contenido.toString('utf8');
  }
}
