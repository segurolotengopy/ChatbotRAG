/**
 * PRUEBA DE `normalizar` (NFKD + quitado de diacríticos)
 *
 * Origen: P16. Con NFD, los dígitos y letras de ancho completo, las ligaduras y los
 * alfabetos matemáticos no llegaban a su forma simple y evadían los detectores de
 * entrada y de salida. Se prueba lo que ahora se pliega, lo que NO cambió, y que el
 * índice RAG (que tokeniza con `normalizar`) produce los mismos términos que con la
 * versión anterior sobre todo el corpus de ejemplo.
 *
 * Qué NO garantiza: caracteres invisibles (\p{Cf}), homóglifos de otros alfabetos
 * ni dígitos escritos con palabras.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { raiz } from '../conocimiento/indice-memoria.js';
import { normalizar } from './vocabulario.js';

/** Copia local de la versión anterior (NFD), solo para la prueba de no regresión. */
function normalizarNfd(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

describe('normalizar: lo que ahora se pliega', () => {
  it.each([
    ['４１１１', '4111'],
    ['ＴＡＲＪＥＴＡ', 'tarjeta'],
    ['ﬁnanciación', 'financiacion'],
    ['m²', 'm2'],
    ['Ⅰ', 'i'],
    ['𝐭𝐚𝐫𝐣𝐞𝐭𝐚', 'tarjeta'],
  ])('%s -> %s', (entrada, esperado) => {
    expect(normalizar(entrada)).toBe(esperado);
  });
});

describe('normalizar: lo que no cambia', () => {
  it.each([
    ['Cédula Ñandú Pingüino', 'cedula nandu pinguino'],
    ['cédula', 'cedula'],
    ['  Hola   Mundo ', 'hola mundo'],
    ['…', '...'],
  ])('%s -> %s', (entrada, esperado) => {
    expect(normalizar(entrada)).toBe(esperado);
  });
});

/** Los mismos pasos de `terminos` salvo el filtro de palabras vacías (función pura del token). */
function tokens(texto: string, norm: (t: string) => string): string[] {
  return norm(texto)
    .replace(/[^a-z0-9ñ ]/g, ' ')
    .split(/\s+/)
    .map(raiz)
    .filter((t) => t.length >= 3);
}

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap((nombre) => {
    const ruta = join(dir, nombre);
    return statSync(ruta).isDirectory() ? archivos(ruta) : [ruta];
  });
}

describe('normalizar: no regresión del índice RAG', () => {
  const corpus = archivos(join(import.meta.dirname, '../../../../configuraciones/corpus'));

  it('hay corpus que comparar', () => {
    expect(corpus.length).toBeGreaterThan(0);
  });

  for (const ruta of corpus) {
    it(`mismos términos con NFKD y NFD: ${ruta.split('corpus/')[1]}`, () => {
      const texto = readFileSync(ruta, 'utf8');
      expect(tokens(texto, normalizar)).toEqual(tokens(texto, normalizarNfd));
    });
  }
});
