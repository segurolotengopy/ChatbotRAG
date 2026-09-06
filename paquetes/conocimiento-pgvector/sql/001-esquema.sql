-- Esquema del índice de conocimiento de ChatbotRAG sobre PostgreSQL + pgvector.
-- Idempotente. La dimensión del vector se fija al crear la tabla: cambiar de
-- modelo de embeddings implica una tabla nueva (o reindexar todo).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS fragmentos (
  id             text PRIMARY KEY,
  coleccion      text NOT NULL,
  fuente_id      text NOT NULL,
  fuente_titulo  text NOT NULL,
  fuente_version text NOT NULL,
  orden          integer NOT NULL,
  texto          text NOT NULL,
  -- 768 = text-embedding-005 (Vertex). Para Titan v2 usar 1024.
  vector         vector(768),
  tsv            tsvector GENERATED ALWAYS AS (to_tsvector('spanish', texto)) STORED,
  creado_en      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fragmentos_coleccion_idx ON fragmentos (coleccion);
CREATE INDEX IF NOT EXISTS fragmentos_tsv_idx ON fragmentos USING gin (tsv);
-- HNSW para coseno; suficiente hasta millones de filas.
CREATE INDEX IF NOT EXISTS fragmentos_vector_idx ON fragmentos USING hnsw (vector vector_cosine_ops);
