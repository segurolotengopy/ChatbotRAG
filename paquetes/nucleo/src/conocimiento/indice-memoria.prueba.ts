import { describe, expect, it } from 'vitest';
import type { Embebedor } from '../puertos/proveedor-llm.js';
import { IndiceEnMemoria } from './indice-memoria.js';

const fragmento = { id: 'f1', coleccion: 'c', fuenteId: 'd', fuenteTitulo: 'D', fuenteVersion: 'v1', orden: 0, texto: 'El proceso tiene pasos.' };

describe('IndiceEnMemoria y la vía de indexación del embebedor', () => {
  it('indexa con embeberParaIndexar si existe y consulta con embeber', async () => {
    const llamadas: string[] = [];
    const embebedor: Embebedor = {
      nombre: 'falso',
      dimension: 2,
      async embeber(t) {
        llamadas.push('consulta');
        return t.map(() => [1, 0]);
      },
      async embeberParaIndexar(t) {
        llamadas.push('indexar');
        return t.map(() => [1, 0]);
      },
    };
    const indice = new IndiceEnMemoria(embebedor);
    await indice.indexar([fragmento]);
    await indice.buscar('proceso pasos', { coleccion: 'c', topK: 3, umbral: 0 });
    expect(llamadas).toEqual(['indexar', 'consulta']);
  });

  it('sin embeberParaIndexar indexa con embeber, como siempre', async () => {
    const llamadas: string[] = [];
    const embebedor: Embebedor = { nombre: 'falso', dimension: 2, async embeber(t) { llamadas.push('embeber'); return t.map(() => [1, 0]); } };
    await new IndiceEnMemoria(embebedor).indexar([fragmento]);
    expect(llamadas).toEqual(['embeber']);
  });
});
