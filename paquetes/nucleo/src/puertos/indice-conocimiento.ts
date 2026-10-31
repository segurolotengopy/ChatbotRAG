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
  /**
   * Marca de un fragmento cuyo contenido nadie validó. Solo la carga del perfil `pruebas` la pone; un índice
   * persistente (la vía de producción) debe rechazar todo fragmento que la traiga.
   */
  validacion?: 'no_validado';
  /** Versión X.Y.Z del paquete de conocimiento de origen; acompaña a `validacion`. */
  versionPaquete?: string;
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
  /**
   * Los primeros `limite` fragmentos de una fuente, ordenados por `orden`. No es una búsqueda:
   * no hay consulta ni puntaje. Lo usa el contexto de página para traer el manual de la pantalla.
   */
  fragmentosDeFuente(coleccion: string, fuenteId: string, limite: number): Promise<Fragmento[]>;
  /** Cantidad de fragmentos de una colección (para diagnósticos y salud). */
  contar(coleccion: string): Promise<number>;
  vaciar(coleccion: string): Promise<void>;
}
