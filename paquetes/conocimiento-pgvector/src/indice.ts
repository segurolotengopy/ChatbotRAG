/**
 * ÍNDICE PGVECTOR — persistente, híbrido (coseno + texto completo en español)
 *
 * Mismo contrato y misma semántica de puntaje (0..1) que `IndiceEnMemoria`, para
 * que `conocimiento.umbral` signifique lo mismo. Funciona sin embeddings (solo
 * `ts_rank`) o con ellos (60 % coseno + 40 % léxico).
 *
 * Único lugar que importa `pg`. El esquema está en `sql/001-esquema.sql`.
 */
import { Pool, type PoolConfig } from 'pg';
import type { Embebedor, Fragmento, FragmentoRecuperado, IndiceConocimiento, OpcionesBusqueda } from '@chatbotrag/nucleo';

export interface ConsultaSql {
  query<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, valores?: unknown[]): Promise<{ rows: T[] }>;
}

export function crearPool(config: PoolConfig): ConsultaSql {
  const pool = new Pool(config);
  return { query: (sql, valores) => pool.query(sql, valores) };
}

function aLiteralVector(v: number[]): string {
  return `[${v.join(',')}]`;
}

export class IndicePgvector implements IndiceConocimiento {
  readonly nombre = 'pgvector';

  constructor(
    private readonly db: ConsultaSql,
    private readonly embebedor: Embebedor | null = null,
  ) {}

  async indexar(fragmentos: Fragmento[]): Promise<void> {
    if (fragmentos.length === 0) return;
    const vectores = this.embebedor ? await this.embebedor.embeber(fragmentos.map((f) => f.texto)) : null;
    for (let i = 0; i < fragmentos.length; i++) {
      const f = fragmentos[i]!;
      await this.db.query(
        `INSERT INTO fragmentos (id, coleccion, fuente_id, fuente_titulo, fuente_version, orden, texto, vector)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (id) DO UPDATE SET texto = EXCLUDED.texto, vector = EXCLUDED.vector, fuente_version = EXCLUDED.fuente_version`,
        [f.id, f.coleccion, f.fuenteId, f.fuenteTitulo, f.fuenteVersion, f.orden, f.texto, vectores ? aLiteralVector(vectores[i]!) : null],
      );
    }
  }

  async buscar(consulta: string, opciones: OpcionesBusqueda): Promise<FragmentoRecuperado[]> {
    const vector = this.embebedor ? (await this.embebedor.embeber([consulta]))[0] ?? null : null;
    // ts_rank_cd normalizado (32 → 0..1 por rank/(rank+1)); coseno = 1 - distancia.
    const filas = await this.db.query<{
      id: string; coleccion: string; fuente_id: string; fuente_titulo: string; fuente_version: string; orden: number; texto: string; lexico: number; vectorial: number | null;
    }>(
      `SELECT id, coleccion, fuente_id, fuente_titulo, fuente_version, orden, texto,
              ts_rank_cd(tsv, websearch_to_tsquery('spanish', $2), 32) AS lexico,
              ${vector ? `CASE WHEN vector IS NULL THEN NULL ELSE 1 - (vector <=> $4::vector) END` : 'NULL'} AS vectorial
         FROM fragmentos
        WHERE coleccion = $1
        ORDER BY ${vector ? `(0.6 * COALESCE(1 - (vector <=> $4::vector), 0) + 0.4 * ts_rank_cd(tsv, websearch_to_tsquery('spanish', $2), 32))` : 'lexico'} DESC
        LIMIT $3`,
      vector ? [opciones.coleccion, consulta, opciones.topK * 3, aLiteralVector(vector)] : [opciones.coleccion, consulta, opciones.topK * 3],
    );
    return filas.rows
      .map((r) => {
        const l = Number(r.lexico) || 0;
        const v = r.vectorial === null ? null : Math.max(0, Number(r.vectorial));
        const puntaje = v === null ? l : 0.6 * v + 0.4 * l;
        return { id: r.id, coleccion: r.coleccion, fuenteId: r.fuente_id, fuenteTitulo: r.fuente_titulo, fuenteVersion: r.fuente_version, orden: r.orden, texto: r.texto, puntaje: Number(Math.min(1, puntaje).toFixed(4)) };
      })
      .filter((f) => f.puntaje >= opciones.umbral)
      .sort((a, b) => b.puntaje - a.puntaje)
      .slice(0, opciones.topK);
  }

  async contar(coleccion: string): Promise<number> {
    const r = await this.db.query<{ n: string }>('SELECT count(*)::text AS n FROM fragmentos WHERE coleccion = $1', [coleccion]);
    return Number(r.rows[0]?.n ?? 0);
  }

  async vaciar(coleccion: string): Promise<void> {
    await this.db.query('DELETE FROM fragmentos WHERE coleccion = $1', [coleccion]);
  }
}
