/**
 * EMBEBEDOR CON MEMORIA Y TOPE DE TIEMPO (modelo híbrido, H4a)
 *
 * Por qué existe: el enrutador semántico y el RAG necesitan el mismo vector del mismo mensaje. Sin memoria, cada
 * mensaje costaría dos llamadas al servicio de embeddings (costo y latencia). `EmbebedorConMemoria` envuelve un
 * `Embebedor` y memoriza la PROMESA del cálculo, no solo el resultado: si el enrutador y el RAG piden el vector a la
 * vez, la segunda petición se engancha a la primera y el servicio recibe UNA sola llamada. `embeberConTiempo` pone un
 * tope a la espera, porque un servicio lento no debe frenar la respuesta: pasado el tope el mensaje sigue por la IA.
 *
 * Defecto que motiva el control: una memoria sin límites crece sin tope y retiene texto de personas. Por eso la
 * clave es el SHA-256 del texto (el texto no se guarda), hay un máximo de 32 entradas (sale la más antigua) y cada
 * una vive 60 s. Una promesa rechazada se descarta al instante: un fallo no se memoriza. Reloj y temporizador son
 * inyectables para probar sin esperar.
 *
 * Qué NO garantiza: que el tope de tiempo cancele la llamada al servicio (solo deja de esperarla; ver
 * `embeberConTiempo`), que dos procesos compartan memoria (es por instancia), ni que el vector devuelto no se muestre
 * en otra parte (se entregan copias para que nadie mute la memoria). No sirve para indexar un banco entero (32
 * entradas); eso lo hace `prepararIndiceSemantico` con el embebedor sin envolver.
 */
import { createHash } from 'node:crypto';
import type { Embebedor } from '../puertos/proveedor-llm.js';
import type { ConsultaSemantica } from './enrutador-semantico.js';

export const MEMORIA_MAXIMO_ENTRADAS = 32;
export const MEMORIA_VIDA_MS = 60_000;

export interface OpcionesMemoria {
  maximo?: number;
  vidaMs?: number;
  /** Reloj en milisegundos; por defecto `Date.now`. */
  ahora?: () => number;
}

interface EntradaMemoria {
  creada: number;
  promesa: Promise<number[]>;
}

export class EmbebedorConMemoria implements Embebedor {
  readonly nombre: string;
  readonly dimension: number;
  private readonly memoria = new Map<string, EntradaMemoria>();
  private readonly maximo: number;
  private readonly vidaMs: number;
  private readonly ahora: () => number;

  constructor(
    private readonly interno: Embebedor,
    opciones: OpcionesMemoria = {},
  ) {
    this.nombre = interno.nombre;
    this.dimension = interno.dimension;
    this.maximo = opciones.maximo ?? MEMORIA_MAXIMO_ENTRADAS;
    this.vidaMs = opciones.vidaMs ?? MEMORIA_VIDA_MS;
    if (!Number.isInteger(this.maximo) || this.maximo < 1) throw new RangeError('maximo debe ser un entero mayor o igual que 1');
    if (!Number.isFinite(this.vidaMs) || this.vidaMs <= 0) throw new RangeError('vidaMs debe ser finito y mayor que 0');
    this.ahora = opciones.ahora ?? Date.now;
  }

  /** Cantidad de entradas vivas (para pruebas y diagnóstico). */
  get tamano(): number {
    this.purgar();
    return this.memoria.size;
  }

  private purgar(): void {
    const t = this.ahora();
    for (const [clave, e] of this.memoria) if (t - e.creada >= this.vidaMs) this.memoria.delete(clave);
  }

  async embeber(textos: string[]): Promise<number[][]> {
    if (textos.length === 0) return [];
    this.purgar();
    const claves = textos.map((t) => createHash('sha256').update(t, 'utf8').digest('hex'));

    // Promesas de ESTA llamada: las de la memoria (se capturan ya, antes de cualquier desalojo) y las del lote nuevo.
    // Así un lote mayor que `maximo` se resuelve igual desde su propia promesa, con una sola llamada al servicio.
    const promesas = new Map<string, Promise<number[]>>();
    const faltantes: string[] = [];
    const clavesFaltantes: string[] = [];
    claves.forEach((clave, i) => {
      const guardada = this.memoria.get(clave);
      if (guardada) promesas.set(clave, guardada.promesa);
      else if (!clavesFaltantes.includes(clave)) {
        clavesFaltantes.push(clave);
        faltantes.push(textos[i] as string);
      }
    });
    if (faltantes.length > 0) {
      const lote = this.interno.embeber(faltantes);
      const creada = this.ahora();
      clavesFaltantes.forEach((clave, j) => {
        const promesa = lote.then((m) => {
          const v = Array.isArray(m) && m.length === faltantes.length ? m[j] : undefined;
          if (!Array.isArray(v)) throw new Error('el embebedor devolvió una cantidad distinta de vectores');
          return v;
        });
        // Un fallo no se memoriza.
        promesa.catch(() => {
          if (this.memoria.get(clave)?.promesa === promesa) this.memoria.delete(clave);
        });
        promesas.set(clave, promesa);
        this.memoria.set(clave, { creada, promesa });
      });
      while (this.memoria.size > this.maximo) {
        const masAntigua = this.memoria.keys().next().value;
        if (masAntigua === undefined) break;
        this.memoria.delete(masAntigua);
      }
    }

    const vectores = await Promise.all(claves.map((clave) => promesas.get(clave) as Promise<number[]>));
    return vectores.map((v) => [...v]);
  }
}

export class ErrorEmbebedorTiempo extends Error {
  constructor() {
    super('tiempo de espera del embebedor agotado');
    this.name = 'ErrorEmbebedorTiempo';
  }
}

/** Programa `accion` dentro de `ms` y devuelve la función que la cancela. Por defecto, `setTimeout`. */
export type Programador = (accion: () => void, ms: number) => () => void;

const programadorPorDefecto: Programador = (accion, ms) => {
  const id = setTimeout(accion, ms);
  return () => clearTimeout(id);
};

/**
 * Embebe con tope de espera; pasado `ms` rechaza con `ErrorEmbebedorTiempo`. El tope NO aborta la llamada en curso:
 * el servicio sigue trabajando (y facturando) hasta terminar, y su resultado tardío se descarta. `ms` debe ser finito
 * y mayor que 0 (si no, `RangeError`: es un error de configuración y no se disfraza de fallo del servicio).
 */
export function embeberConTiempo(embebedor: Embebedor, textos: string[], ms: number, programar: Programador = programadorPorDefecto): Promise<number[][]> {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('el tope de tiempo debe ser finito y mayor que 0');
  return new Promise<number[][]>((resolver, rechazar) => {
    const cancelar = programar(() => rechazar(new ErrorEmbebedorTiempo()), ms);
    let llamada: Promise<number[][]>;
    try {
      llamada = embebedor.embeber(textos);
    } catch (e) {
      // Un embebedor que lanza de forma síncrona no deja el temporizador vivo.
      cancelar();
      rechazar(e);
      return;
    }
    llamada.then(
      (v) => {
        cancelar();
        resolver(v);
      },
      (e: unknown) => {
        cancelar();
        rechazar(e);
      },
    );
  });
}

/**
 * Calcula el vector de UNA consulta y lo traduce al estado que espera `enrutarConSemantica`. Nunca rechaza por un fallo
 * del servicio; solo lanza `RangeError` si `ms` es inválido (error de configuración).
 */
export async function consultarEmbedding(embebedor: Embebedor, texto: string, ms: number, programar?: Programador): Promise<ConsultaSemantica> {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError('el tope de tiempo debe ser finito y mayor que 0');
  try {
    const m = await embeberConTiempo(embebedor, [texto], ms, programar);
    const vector = Array.isArray(m) && m.length === 1 ? m[0] : undefined;
    return Array.isArray(vector) ? { estado: 'ok', vector } : { estado: 'error' };
  } catch (e) {
    return e instanceof ErrorEmbebedorTiempo ? { estado: 'tiempo' } : { estado: 'error' };
  }
}
