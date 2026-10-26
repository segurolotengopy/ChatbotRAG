/**
 * Pruebas de la carga del paquete de Kuaa. Todo es sintético y los conteos esperados se escriben a mano.
 */
import { describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import type { Fragmento, FragmentoRecuperado, IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import { cargarPaqueteKuaa, type LectorPaquete } from './cargar-paquete.js';

class IndiceEspia implements IndiceConocimiento {
  readonly nombre = 'espia';
  readonly indexados: Fragmento[] = [];
  async indexar(f: Fragmento[]): Promise<void> {
    this.indexados.push(...f);
  }
  async buscar(): Promise<FragmentoRecuperado[]> {
    return [];
  }
  async fragmentosDeFuente(): Promise<Fragmento[]> {
    return [];
  }
  async contar(): Promise<number> {
    return this.indexados.length;
  }
  async vaciar(): Promise<void> {}
}

const NV = { habilitado_produccion: false, validacion: 'no_validado', version_paquete: '1.0.0' };
const reg = (n: string) => ({ id: n, pregunta: `pregunta ${n}`, ...NV });

function lector(archivos: Record<string, string>, version = '1.0.0', rutas = Object.keys(archivos)): LectorPaquete {
  return {
    async leerManifiesto() {
      return { version, archivos: rutas.map((ruta) => ({ ruta, titular: 'interseguros' })) };
    },
    async leer(ruta) {
      const t = archivos[ruta];
      if (t === undefined) throw new Error('no existe');
      return t;
    },
  };
}

const OPC = { agenteId: 'kuaa', versionEsperada: '1.0.0', tamano: 900, solapamiento: 100 };

describe('cargarPaqueteKuaa', () => {
  it('indexa las tres formas de JSON y un documento de texto: 3 + 2 + 1 + 1', async () => {
    const indice = new IndiceEspia();
    const l = lector({
      'a.json': JSON.stringify([reg('1'), reg('2'), reg('3')]),
      'b.json': JSON.stringify({ registros: [reg('4'), reg('5')] }),
      'c.json': JSON.stringify(reg('6')),
      'manual.md': '# Manual\n\nTexto sintético del manual.',
    });
    const r = await cargarPaqueteKuaa(l, 'pruebas', indice, 'kuaa', OPC);
    expect(r).toEqual({ fragmentos: 7, rechazados: 0, version: '1.0.0' });
    expect(indice.indexados).toHaveLength(7);
    for (const f of indice.indexados) {
      expect(f.validacion).toBe('no_validado');
      expect(f.versionPaquete).toBe('1.0.0');
      expect(f.coleccion).toBe('kuaa');
      expect(f.texto).not.toMatch(/habilitado_produccion|version_paquete/);
    }
  });

  it('con perfil produccion ningún fragmento no_validado llega al índice', async () => {
    const indice = new IndiceEspia();
    const l = lector({
      'a.json': JSON.stringify([reg('1'), reg('2'), reg('3')]),
      'b.json': JSON.stringify({ registros: [reg('4')] }),
      'manual.md': '# Manual\n\nTexto sintético.',
    });
    const r = await cargarPaqueteKuaa(l, 'produccion', indice, 'kuaa', OPC);
    expect(indice.indexados).toHaveLength(0);
    expect(indice.indexados.filter((f) => f.validacion !== undefined)).toHaveLength(0);
    expect(r.fragmentos).toBe(0);
    expect(r.rechazados).toBe(5);
  });

  it('con perfil produccion un registro habilitado entra sin marca y los no validados no', async () => {
    const indice = new IndiceEspia();
    const l = lector({ 'a.json': JSON.stringify([{ id: 'ok', pregunta: 'p', habilitado_produccion: true }, reg('2')]) });
    const r = await cargarPaqueteKuaa(l, 'produccion', indice, 'kuaa', OPC);
    expect(r).toEqual({ fragmentos: 1, rechazados: 1, version: '1.0.0' });
    expect(indice.indexados[0]!.validacion).toBeUndefined();
  });

  it('rechaza una forma desconocida, un JSON roto y una extensión no admitida sin abortar', async () => {
    const indice = new IndiceEspia();
    const l = lector({ 'a.json': '42', 'b.json': '{no es json', 'c.pdf': 'x', 'd.json': JSON.stringify([reg('1')]) });
    const r = await cargarPaqueteKuaa(l, 'pruebas', indice, 'kuaa', OPC);
    expect(r).toEqual({ fragmentos: 1, rechazados: 3, version: '1.0.0' });
  });

  it('rechaza el registro true marcado no_validado y el que no trae la marca', async () => {
    const indice = new IndiceEspia();
    const l = lector({ 'a.json': JSON.stringify([{ id: 'x', habilitado_produccion: true, validacion: 'no_validado' }, { id: 'y', habilitado_produccion: false }, reg('3')]) });
    const r = await cargarPaqueteKuaa(l, 'pruebas', indice, 'kuaa', OPC);
    expect(r.fragmentos).toBe(1);
    expect(r.rechazados).toBe(2);
  });

  it('aborta si la versión del manifiesto no es la esperada o el manifiesto es inválido', async () => {
    const indice = new IndiceEspia();
    await expect(cargarPaqueteKuaa(lector({ 'a.json': '[]' }, '2.0.0'), 'pruebas', indice, 'kuaa', OPC)).rejects.toThrow(/versión/);
    await expect(cargarPaqueteKuaa(lector({ 'a.json': '[]' }, '1.0.0', ['../fuera.json']), 'pruebas', indice, 'kuaa', OPC)).rejects.toThrow();
    const sinForma: LectorPaquete = { leerManifiesto: async () => ({ version: 'x' }), leer: async () => '' };
    await expect(cargarPaqueteKuaa(sinForma, 'pruebas', indice, 'kuaa', OPC)).rejects.toThrow();
    expect(indice.indexados).toHaveLength(0);
  });

  it('la bitácora lleva solo conteos, jamás el contenido', async () => {
    const indice = new IndiceEspia();
    const bitacora = new BitacoraEnMemoria();
    const l = lector({ 'a.json': JSON.stringify([{ ...reg('1'), pregunta: 'TEXTO-SECRETO-SINTETICO' }]) });
    await cargarPaqueteKuaa(l, 'pruebas', indice, 'kuaa', OPC, bitacora);
    expect(JSON.stringify(bitacora.eventos)).not.toContain('TEXTO-SECRETO-SINTETICO');
    expect(bitacora.eventos[0]!.detalle).toBe('paquete=1.0.0 perfil=pruebas coleccion=kuaa fragmentos=1 rechazados=0');
  });
});
