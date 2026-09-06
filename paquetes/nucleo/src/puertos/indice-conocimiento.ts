/**
 * PUERTO: ÍNDICE DE CONOCIMIENTO (RAG)
 *
 * Un índice recibe fragmentos ya troceados y responde a consultas con los más
 * parecidos y su puntaje (0..1, mayor es mejor). El núcleo no sabe si detrás hay
 * un arreglo en memoria, pgvector o Vertex AI Search: solo exige que el puntaje
 * sea comparable con `conocimiento.umbral`.
 *
 * La `coleccion` aísla corpus: dos perfiles (dos seguros) no deben mezclar sus
 * fragmentos aunque compartan el índice físico.
 */
export interface Fragmento {
  id: string;
  coleccion: string;
  fuenteId: string;
  fuenteTitulo: string;
  fuenteVersion: string;
  orden: number;
  texto: string;
}

export interface FragmentoRecuperado extends Fragmento {
  puntaje: number;
}

export interface OpcionesBusqueda {
  coleccion: string;
  topK: number;
  umbral: number;
}

export interface IndiceConocimiento {
  readonly nombre: string;
  indexar(fragmentos: Fragmento[]): Promise<void>;
  buscar(consulta: string, opciones: OpcionesBusqueda): Promise<FragmentoRecuperado[]>;
  /** Cantidad de fragmentos de una colección (para diagnósticos y salud). */
  contar(coleccion: string): Promise<number>;
  vaciar(coleccion: string): Promise<void>;
}
