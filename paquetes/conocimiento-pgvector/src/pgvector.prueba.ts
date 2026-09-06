import { describe, expect, it } from 'vitest';
import { IndicePgvector, type ConsultaSql } from './indice.js';

/** Base falsa: guarda las consultas y devuelve filas preparadas. */
function dbFalsa(filas: Record<string, unknown>[] = []) {
  const consultas: Array<{ sql: string; valores: unknown[] | undefined }> = [];
  const db: ConsultaSql = {
    async query(sql, valores) {
      consultas.push({ sql, valores });
      if (/^SELECT count/.test(sql)) return { rows: [{ n: String(filas.length) }] as never };
      if (/^SELECT id/.test(sql)) return { rows: filas as never };
      return { rows: [] };
    },
  };
  return { db, consultas };
}

describe('IndicePgvector', () => {
  it('indexa con upsert y sin vector cuando no hay embebedor', async () => {
    const { db, consultas } = dbFalsa();
    const i = new IndicePgvector(db);
    await i.indexar([{ id: 'a', coleccion: 'c', fuenteId: 'f', fuenteTitulo: 'T', fuenteVersion: '1', orden: 0, texto: 'hola' }]);
    expect(consultas[0]!.sql).toMatch(/ON CONFLICT \(id\) DO UPDATE/);
    expect(consultas[0]!.valores![7]).toBeNull();
  });

  it('busca por texto completo y normaliza el puntaje', async () => {
    const { db, consultas } = dbFalsa([
      { id: 'a', coleccion: 'c', fuente_id: 'f', fuente_titulo: 'T', fuente_version: '1', orden: 0, texto: 'x', lexico: 0.6, vectorial: null },
      { id: 'b', coleccion: 'c', fuente_id: 'f', fuente_titulo: 'T', fuente_version: '1', orden: 1, texto: 'y', lexico: 0.1, vectorial: null },
    ]);
    const r = await new IndicePgvector(db).buscar('carencia', { coleccion: 'c', topK: 5, umbral: 0.3 });
    expect(r.map((f) => f.id)).toEqual(['a']);
    expect(consultas[0]!.sql).toMatch(/websearch_to_tsquery\('spanish'/);
    expect(consultas[0]!.valores).toEqual(['c', 'carencia', 15]);
  });

  it('combina coseno y léxico cuando hay embebedor', async () => {
    const { db, consultas } = dbFalsa([{ id: 'a', coleccion: 'c', fuente_id: 'f', fuente_titulo: 'T', fuente_version: '1', orden: 0, texto: 'x', lexico: 0.5, vectorial: 0.9 }]);
    const emb = { nombre: 'e', dimension: 2, embeber: async (t: string[]) => t.map(() => [1, 0]) };
    const r = await new IndicePgvector(db, emb).buscar('q', { coleccion: 'c', topK: 1, umbral: 0 });
    expect(r[0]!.puntaje).toBeCloseTo(0.74, 2);
    expect(consultas[0]!.valores![3]).toBe('[1,0]');
    expect(consultas[0]!.sql).toMatch(/<=>/);
  });

  it('cuenta y vacía por colección', async () => {
    const { db, consultas } = dbFalsa([{}, {}]);
    const i = new IndicePgvector(db);
    expect(await i.contar('c')).toBe(2);
    await i.vaciar('c');
    expect(consultas[1]!.sql).toMatch(/DELETE FROM fragmentos WHERE coleccion/);
  });
});
