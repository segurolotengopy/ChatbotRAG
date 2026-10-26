/**
 * Pruebas de la preparación del paquete de Kuaa. Solo fixtures sintéticos; el conversor de .docx se inyecta.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepararPaquete, type EntradaLista } from './preparar-paquete-kuaa.mjs';

const ORIGEN = fileURLToPath(new URL('./__fixtures__/paquete-sintetico', import.meta.url));
const LISTA: EntradaLista[] = [
  { ruta: 'A/LISTA.json', titular: 'interseguros' },
  { ruta: 'A/REGISTROS.json', titular: 'interseguros' },
  { ruta: 'A/FICHA.json', titular: 'interseguros' },
  { ruta: 'B/MANUAL.docx', titular: 'alianza' },
];
const carpetaNueva = () => join(mkdtempSync(join(tmpdir(), 'preparar-kuaa-')), 'salida');
const conversor = async () => '# Manual sintético\n\nTexto convertido.';
const leer = (c: string, n: string) => readFileSync(join(c, n), 'utf8');

describe('prepararPaquete', () => {
  it('estampa los tres tipos de raíz, convierte el docx y excluye lo que no está en la lista', async () => {
    const salida = carpetaNueva();
    const r = await prepararPaquete({ origen: ORIGEN, salida, version: '1.2.3', lista: LISTA, convertirDocx: conversor });
    expect(r).toEqual({ archivos: 4, registros: 2 + 1 + 1 + 1 });
    expect(readdirSync(salida).sort()).toEqual(['FICHA.json', 'LISTA.json', 'MANUAL.md', 'REGISTROS.json', 'manifiesto.json']);
    const marcas = { habilitado_produccion: false, validacion: 'no_validado', version_paquete: '1.2.3' };
    const lista = JSON.parse(leer(salida, 'LISTA.json')) as Array<Record<string, unknown>>;
    expect(lista).toHaveLength(2);
    // El segundo registro traía `true`: se fuerza a false.
    for (const x of lista) expect(x).toMatchObject(marcas);
    expect(JSON.parse(leer(salida, 'REGISTROS.json'))).toEqual({ registros: [{ id: 'r1', pregunta: '¿Qué es esto?', respuesta: 'Un dato sintético.', ...marcas }] });
    expect(JSON.parse(leer(salida, 'FICHA.json'))).toEqual({ id: 'ficha', planes: ['plan sintético'], ...marcas });
    expect(leer(salida, 'MANUAL.md')).toBe('# Manual sintético\n\nTexto convertido.\n');
  });

  it('el manifiesto de salida lleva la huella y el titular de cada archivo', async () => {
    const salida = carpetaNueva();
    await prepararPaquete({ origen: ORIGEN, salida, version: '1.2.3', lista: LISTA, convertirDocx: conversor });
    const m = JSON.parse(leer(salida, 'manifiesto.json')) as { version: string; origen_sha256: string; archivos: Array<{ ruta: string; sha256: string; bytes: number; titular: string }> };
    expect(m.version).toBe('1.2.3');
    expect(m.origen_sha256).toBe(createHash('sha256').update(readFileSync(join(ORIGEN, 'MANIFIESTO.json'))).digest('hex'));
    expect(m.archivos.map((a) => a.ruta).sort()).toEqual(['FICHA.json', 'LISTA.json', 'MANUAL.md', 'REGISTROS.json']);
    expect(m.archivos.find((a) => a.ruta === 'MANUAL.md')!.titular).toBe('alianza');
    for (const a of m.archivos) {
      const contenido = readFileSync(join(salida, a.ruta));
      expect(a.sha256).toBe(createHash('sha256').update(contenido).digest('hex'));
      expect(a.bytes).toBe(contenido.length);
    }
  });

  it('se niega a escribir dentro del repositorio, del origen o de una carpeta con contenido', async () => {
    const base = { origen: ORIGEN, version: '1.0.0', lista: LISTA, convertirDocx: conversor };
    await expect(prepararPaquete({ ...base, salida: join(fileURLToPath(new URL('..', import.meta.url)), 'salida-prohibida') })).rejects.toThrow(/repositorio/);
    await expect(prepararPaquete({ ...base, salida: join(ORIGEN, 'salida') })).rejects.toThrow();
    const ocupada = mkdtempSync(join(tmpdir(), 'preparar-kuaa-'));
    writeFileSync(join(ocupada, 'x'), 'x');
    await expect(prepararPaquete({ ...base, salida: ocupada })).rejects.toThrow(/vacía/);
  });

  it('rechaza una versión inválida y un archivo ausente del manifiesto de origen', async () => {
    const base = { origen: ORIGEN, lista: LISTA, convertirDocx: conversor };
    await expect(prepararPaquete({ ...base, salida: carpetaNueva(), version: 'v1' })).rejects.toThrow(/X\.Y\.Z/);
    await expect(prepararPaquete({ ...base, salida: carpetaNueva(), version: '1.0.0', lista: [{ ruta: 'A/NO_EXISTE.json', titular: 'interseguros' }] })).rejects.toThrow(/falta en el manifiesto/);
  });

  it('un archivo alterado respecto de su huella invalida la preparación y no escribe nada', async () => {
    const copia = mkdtempSync(join(tmpdir(), 'origen-kuaa-'));
    cpSync(ORIGEN, copia, { recursive: true });
    writeFileSync(join(copia, 'A/LISTA.json'), '[{"id":"alterado"}]');
    const salida = carpetaNueva();
    await expect(prepararPaquete({ origen: copia, salida, version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/SHA-256/);
    expect(() => readdirSync(salida)).toThrow();
  });

  it('una conversión vacía del docx falla', async () => {
    await expect(prepararPaquete({ origen: ORIGEN, salida: carpetaNueva(), version: '1.0.0', lista: LISTA, convertirDocx: async () => '   ' })).rejects.toThrow(/vacía/);
  });
});
