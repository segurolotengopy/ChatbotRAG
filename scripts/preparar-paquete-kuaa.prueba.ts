/**
 * Pruebas de la preparación del paquete de Kuaa. Solo fixtures sintéticos; el conversor de .docx se inyecta.
 */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { LISTA_PAQUETE_REAL, prepararPaquete, quitarImagenesIncrustadas, type EntradaLista } from './preparar-paquete-kuaa.mjs';

const ORIGEN = fileURLToPath(new URL('./__fixtures__/paquete-sintetico', import.meta.url));
const LISTA: EntradaLista[] = [
  { ruta: 'A/LISTA.json', titular: 'interseguros' },
  { ruta: 'A/REGISTROS.json', titular: 'interseguros' },
  { ruta: 'A/FICHA.json', titular: 'interseguros' },
  { ruta: 'B/MANUAL.docx', titular: 'alianza' },
];
const temporales: string[] = [];
/** Carpeta temporal propia que se borra al terminar. */
const temporal = (prefijo: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefijo));
  temporales.push(d);
  return d;
};
afterAll(() => {
  for (const d of temporales) rmSync(d, { recursive: true, force: true });
});
const carpetaNueva = () => join(temporal('preparar-kuaa-'), 'salida');
const conversor = async () => '# Manual sintético\n\nTexto convertido.';
const leer = (c: string, n: string) => readFileSync(join(c, n), 'utf8');

describe('prepararPaquete', () => {
  it('estampa los tres tipos de raíz, convierte el docx y excluye lo que no está en la lista', async () => {
    const salida = carpetaNueva();
    const r = await prepararPaquete({ origen: ORIGEN, salida, version: '1.2.3', lista: LISTA, convertirDocx: conversor });
    expect(r).toEqual({ archivos: 4, registros: 2 + 1 + 1 + 1, revisionHumana: [] });
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
    const ocupada = temporal('preparar-kuaa-');
    writeFileSync(join(ocupada, 'x'), 'x');
    await expect(prepararPaquete({ ...base, salida: ocupada })).rejects.toThrow(/vacía/);
  });

  it('rechaza una versión inválida y un archivo ausente del manifiesto de origen', async () => {
    const base = { origen: ORIGEN, lista: LISTA, convertirDocx: conversor };
    await expect(prepararPaquete({ ...base, salida: carpetaNueva(), version: 'v1' })).rejects.toThrow(/X\.Y\.Z/);
    await expect(prepararPaquete({ ...base, salida: carpetaNueva(), version: '1.0.0', lista: [{ ruta: 'A/NO_EXISTE.json', titular: 'interseguros' }] })).rejects.toThrow(/falta en el manifiesto/);
  });

  it('un archivo alterado respecto de su huella invalida la preparación y no escribe nada', async () => {
    const copia = temporal('origen-kuaa-');
    cpSync(ORIGEN, copia, { recursive: true });
    writeFileSync(join(copia, 'A/LISTA.json'), '[{"id":"alterado"}]');
    const salida = carpetaNueva();
    await expect(prepararPaquete({ origen: copia, salida, version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/SHA-256/);
    expect(() => readdirSync(salida)).toThrow();
  });

  it('una conversión vacía del docx falla', async () => {
    await expect(prepararPaquete({ origen: ORIGEN, salida: carpetaNueva(), version: '1.0.0', lista: LISTA, convertirDocx: async () => '   ' })).rejects.toThrow(/vacía/);
  });

  it('se niega a escribir en la raíz real del repositorio, en ~/Documentos (cualquier capitalización) y vía un enlace simbólico', async () => {
    const base = { origen: ORIGEN, version: '1.0.0', lista: LISTA, convertirDocx: conversor };
    const raizRepo = fileURLToPath(new URL('../../../..', import.meta.url)); // raíz real del repositorio cuando corre en un worktree
    await expect(prepararPaquete({ ...base, salida: join(raizRepo, 'salida-prohibida') })).rejects.toThrow(/repositorio/);
    await expect(prepararPaquete({ ...base, salida: join(homedir(), 'DOCUMENTOS', 'salida-prohibida') })).rejects.toThrow(/Documentos/);
    await expect(prepararPaquete({ ...base, salida: join(homedir(), 'documentos', 'x') })).rejects.toThrow(/Documentos/);
    const tmp = temporal('preparar-kuaa-');
    symlinkSync(fileURLToPath(new URL('..', import.meta.url)), join(tmp, 'enlace'));
    await expect(prepararPaquete({ ...base, salida: join(tmp, 'enlace', 'dentro') })).rejects.toThrow(/repositorio/);
    symlinkSync(carpetaNueva().replace(/salida$/, ''), join(tmp, 'enlace-salida'));
    await expect(prepararPaquete({ ...base, salida: join(tmp, 'enlace-salida') })).rejects.toThrow(/enlace simbólico/);
  });

  it('una salida cuyo nombre empieza con «..» pero está dentro del origen se rechaza como dentro del origen', async () => {
    const copia = temporal('origen-kuaa-');
    cpSync(ORIGEN, copia, { recursive: true });
    await expect(prepararPaquete({ origen: copia, salida: join(copia, '..salida'), version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/dentro del origen/);
    await expect(prepararPaquete({ origen: copia, salida: join(copia, '..salida2', 'x'), version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/dentro del origen/);
  });

  it('un archivo de origen que es un enlace simbólico se rechaza', async () => {
    const copia = temporal('origen-kuaa-');
    cpSync(ORIGEN, copia, { recursive: true });
    const objetivo = join(copia, 'A/FICHA.copia');
    cpSync(join(copia, 'A/FICHA.json'), objetivo);
    cpSync(objetivo, join(copia, 'A/FICHA.json'), { force: true });
    // Reemplazo del archivo por un enlace con el mismo contenido (la huella coincidiría).
    rmSync(join(copia, 'A/FICHA.json'));
    symlinkSync(objetivo, join(copia, 'A/FICHA.json'));
    await expect(prepararPaquete({ origen: copia, salida: carpetaNueva(), version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/enlace simbólico/);
  });

  it('elimina las imágenes incrustadas del Markdown convertido', async () => {
    const salida = carpetaNueva();
    const conImagen = async () => '# T\n\n![logo](data:image/png;base64,AAAA) texto ![x](data:image/png;base64,BBBB)\n\n![ok](https://ejemplo.invalid/a.png)';
    await prepararPaquete({ origen: ORIGEN, salida, version: '1.0.0', lista: LISTA, convertirDocx: conImagen });
    const md = leer(salida, 'MANUAL.md');
    expect(md).not.toContain('data:');
    expect(md).toContain('texto');
    expect(quitarImagenesIncrustadas('![a](data:x;base64,Z)')).toBe('');
    expect(quitarImagenesIncrustadas('sin imágenes')).toBe('sin imágenes');
  });

  it('un .docx por encima del tope de tamaño se rechaza', async () => {
    const copia = temporal('origen-kuaa-');
    cpSync(ORIGEN, copia, { recursive: true });
    const grande = 'x'.repeat(5 * 1024 * 1024 + 1);
    writeFileSync(join(copia, 'B/MANUAL.docx'), grande);
    const manifiesto = JSON.parse(readFileSync(join(copia, 'MANIFIESTO.json'), 'utf8')) as { archivos: Array<{ archivo: string; sha256: string; bytes: number }> };
    const e = manifiesto.archivos.find((a) => a.archivo === 'B/MANUAL.docx')!;
    e.sha256 = createHash('sha256').update(grande).digest('hex');
    e.bytes = grande.length;
    writeFileSync(join(copia, 'MANIFIESTO.json'), JSON.stringify(manifiesto));
    await expect(prepararPaquete({ origen: copia, salida: carpetaNueva(), version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/supera/);
  });

  it('la lista real no incluye el manual de capacitación para IA y marca las conversaciones para revisión humana', () => {
    expect(LISTA_PAQUETE_REAL.some((e) => e.ruta.includes('MANUAL_CAPACITACION_IA'))).toBe(false);
    expect(LISTA_PAQUETE_REAL.filter((e) => e.revisionHumana).map((e) => e.ruta)).toEqual(['01_MANUAL_INFORMATIVO_Y_BASE/CONVERSACIONES.json']);
  });

  it('el resumen informa los archivos que piden revisión humana', async () => {
    const lista: EntradaLista[] = [{ ruta: 'A/LISTA.json', titular: 'interseguros', revisionHumana: true }];
    const r = await prepararPaquete({ origen: ORIGEN, salida: carpetaNueva(), version: '1.0.0', lista });
    expect(r.revisionHumana).toEqual(['A/LISTA.json']);
  });

  it('un directorio intermedio que es enlace simbólico hacia fuera del origen se rechaza', async () => {
    const copia = temporal('origen-kuaa-');
    cpSync(ORIGEN, copia, { recursive: true });
    const fuera = temporal('fuera-kuaa-');
    cpSync(join(copia, 'A'), fuera, { recursive: true }); // mismos archivos y mismas huellas
    rmSync(join(copia, 'A'), { recursive: true });
    symlinkSync(fuera, join(copia, 'A'));
    await expect(prepararPaquete({ origen: copia, salida: carpetaNueva(), version: '1.0.0', lista: LISTA, convertirDocx: conversor })).rejects.toThrow(/fuera del origen/);
  });

  it('quita cualquier URI data: y rechaza el archivo si queda uno', async () => {
    const salida = carpetaNueva();
    const conUri = async () => 'Texto [enlace](data:text/html;base64,PHNjcmlwdD4=) y data:application/json,abc más; metadata: es una palabra';
    await prepararPaquete({ origen: ORIGEN, salida, version: '1.0.0', lista: LISTA, convertirDocx: conUri });
    const md = leer(salida, 'MANUAL.md');
    expect(md).not.toMatch(/(?<![a-z])data:/i);
    expect(md).toContain('metadata: es una palabra');
    const queda = async () => 'Intento: data: sin carga útil que sobrevive';
    await expect(prepararPaquete({ origen: ORIGEN, salida: carpetaNueva(), version: '1.0.0', lista: LISTA, convertirDocx: queda })).rejects.toThrow(/data:/);
  });
});
