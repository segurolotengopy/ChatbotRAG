/**
 * ÍNDICE EN MEMORIA — recuperación híbrida (vectorial + léxica)
 *
 * Sirve para desarrollo, pruebas y despliegues pequeños (un corpus de decenas de
 * documentos por perfil entra holgado en memoria). Dos señales combinadas:
 *
 *  - Similitud coseno entre embeddings (si hay `Embebedor`).
 *  - BM25 simplificado sobre términos normalizados (siempre). Es lo que hace que
 *    «carencia» encuentre el fragmento de carencias aunque el embedding lo
 *    ubique lejos, y lo que permite funcionar sin nube en el modo simulado.
 *
 * El puntaje final es la combinación ponderada normalizada a 0..1, comparable con
 * `conocimiento.umbral`. No pretende competir con Vertex AI Search; pretende que
 * el núcleo sea probable y que el umbral signifique lo mismo en todos los índices.
 */
import type { Embebedor } from '../puertos/proveedor-llm.js';
import type { Fragmento, FragmentoRecuperado, IndiceConocimiento, OpcionesBusqueda } from '../puertos/indice-conocimiento.js';
import { normalizar } from '../compuertas/vocabulario.js';

// Palabras vacías: artículos, preposiciones y los verbos genéricos con que se
// formulan preguntas («¿hacen envíos?», «¿puedo pagar…?»). Un verbo genérico que
// no aparece en el corpus castigaría el puntaje sin aportar información.
const VACIAS = new Set([
  'de', 'la', 'el', 'los', 'las', 'que', 'y', 'en', 'un', 'una', 'unos', 'unas', 'por', 'para', 'con', 'sin', 'del', 'al', 'es', 'se', 'su', 'sus', 'lo', 'le', 'les',
  'a', 'o', 'e', 'u', 'si', 'no', 'mi', 'mis', 'me', 'te', 'tu', 'tus', 'vos', 'usted', 'ustedes', 'como', 'mas', 'muy', 'sobre', 'este', 'esta', 'esto', 'estos', 'estas', 'ese', 'esa', 'eso',
  'hay', 'ser', 'son', 'era', 'fue', 'esta', 'estan', 'estoy', 'tiene', 'tienen', 'tengo', 'tenes', 'tienes', 'puedo', 'puede', 'pueden', 'podes', 'puedes', 'podria', 'podrian',
  'quiero', 'quisiera', 'gustaria', 'necesito', 'saber', 'hace', 'hacen', 'hacer', 'hago', 'hacemos', 'dan', 'dar', 'tambien', 'favor', 'hola', 'gracias', 'buenas', 'buenos',
  'cual', 'cuales', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'donde', 'cuando', 'quien', 'quienes', 'que', 'porque', 'para', 'algo', 'alguna', 'alguno', 'otra', 'otro',
]);

export function terminos(texto: string): string[] {
  return normalizar(texto)
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .split(/\s+/)
    .map(raiz)
    .filter((t) => t.length >= 3 && !VACIAS.has(t));
}

/** Raíz muy simple para español: quita plurales y algunas terminaciones. */
export function raiz(t: string): string {
  if (t.length <= 4) return t;
  return t.replace(/(ciones|cion|mente|idades|idad|ados|adas|ado|ada|idos|idas|ido|ida|es|s)$/, '');
}

interface Entrada {
  fragmento: Fragmento;
  vector: number[] | null;
  tf: Map<string, number>;
  largo: number;
}

function coseno(a: number[], b: number[]): number {
  let p = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    p += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : p / Math.sqrt(na * nb);
}

export class IndiceEnMemoria implements IndiceConocimiento {
  readonly nombre = 'memoria';
  private readonly colecciones = new Map<string, Entrada[]>();

  constructor(private readonly embebedor: Embebedor | null = null) {}

  async indexar(fragmentos: Fragmento[]): Promise<void> {
    const vectores = this.embebedor && fragmentos.length ? await this.embebedor.embeber(fragmentos.map((f) => f.texto)) : null;
    fragmentos.forEach((f, i) => {
      const lista = this.colecciones.get(f.coleccion) ?? [];
      const ts = terminos(f.texto);
      const tf = new Map<string, number>();
      for (const t of ts) tf.set(t, (tf.get(t) ?? 0) + 1);
      // Reemplazo por id: reindexar el mismo documento no duplica.
      const existente = lista.findIndex((e) => e.fragmento.id === f.id);
      const entrada: Entrada = { fragmento: f, vector: vectores ? (vectores[i] ?? null) : null, tf, largo: ts.length };
      if (existente >= 0) lista[existente] = entrada;
      else lista.push(entrada);
      this.colecciones.set(f.coleccion, lista);
    });
  }

  async buscar(consulta: string, opciones: OpcionesBusqueda): Promise<FragmentoRecuperado[]> {
    const lista = this.colecciones.get(opciones.coleccion) ?? [];
    if (lista.length === 0) return [];

    const lexico = this.puntajesLexicos(consulta, lista);
    let vectorial: number[] | null = null;
    if (this.embebedor && lista.some((e) => e.vector)) {
      const [qv] = await this.embebedor.embeber([consulta]);
      if (qv) vectorial = lista.map((e) => (e.vector ? Math.max(0, coseno(qv, e.vector)) : 0));
    }

    const combinados = lista.map((e, i) => {
      const l = lexico[i] ?? 0;
      const v = vectorial ? (vectorial[i] ?? 0) : 0;
      // Sin embeddings, el léxico manda. Con ellos, 60/40 a favor del vector.
      const puntaje = vectorial ? 0.6 * v + 0.4 * l : l;
      return { fragmento: e.fragmento, puntaje: Math.min(1, puntaje) };
    });

    return combinados
      .filter((c) => c.puntaje >= opciones.umbral)
      .sort((a, b) => b.puntaje - a.puntaje)
      .slice(0, opciones.topK)
      .map((c) => ({ ...c.fragmento, puntaje: Number(c.puntaje.toFixed(4)) }));
  }

  /** BM25 normalizado a 0..1 por el máximo teórico de la consulta. */
  private puntajesLexicos(consulta: string, lista: Entrada[]): number[] {
    const q = [...new Set(terminos(consulta))];
    if (q.length === 0) return lista.map(() => 0);
    const N = lista.length;
    const largoMedio = lista.reduce((s, e) => s + e.largo, 0) / N || 1;
    const k1 = 1.4;
    const b = 0.75;
    const df = new Map<string, number>();
    for (const t of q) df.set(t, lista.filter((e) => e.tf.has(t)).length);
    const idf = (t: string) => Math.log(1 + (N - (df.get(t) ?? 0) + 0.5) / ((df.get(t) ?? 0) + 0.5));
    // El máximo se calcula solo con los términos que existen en la colección: una
    // palabra que no aparece en ningún fragmento («cuesta» cuando el corpus dice
    // «premio») no aporta información y no debe castigar el puntaje.
    const presentes = q.filter((t) => (df.get(t) ?? 0) > 0);
    if (presentes.length === 0) return lista.map(() => 0);
    const maximo = presentes.reduce((s, t) => s + idf(t) * (k1 + 1), 0) || 1;
    return lista.map((e) => {
      let s = 0;
      for (const t of q) {
        const f = e.tf.get(t) ?? 0;
        if (f === 0) continue;
        s += idf(t) * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * e.largo) / largoMedio)));
      }
      // Los términos raros pesan más; la fracción respecto al máximo da 0..1. La
      // proporción de términos conocidos penaliza consultas que solo comparten una
      // palabra genérica con el corpus («¿cubre granizo?» contra un seguro de vida).
      return Math.min(1, (s / maximo) * Math.sqrt(presentes.length / q.length));
    });
  }

  async contar(coleccion: string): Promise<number> {
    return this.colecciones.get(coleccion)?.length ?? 0;
  }

  async vaciar(coleccion: string): Promise<void> {
    this.colecciones.delete(coleccion);
  }
}
