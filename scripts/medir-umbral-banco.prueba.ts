/**
 * Prueba del script de medición de umbrales con archivos sintéticos en un directorio temporal (fuera del repo).
 * Comprueba que solo se imprimen conteos y SHA-256, que nunca sale texto de casos ni del banco, que rechaza rutas
 * dentro del repositorio y que el banco sintético solo corre con el proveedor simulado.
 */
import { execFile } from 'node:child_process';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const ejecutar = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./medir-umbral-banco.mts', import.meta.url));
const BANCO_EJEMPLO = fileURLToPath(new URL('../paquetes/nucleo/src/banco/banco-ejemplo.json', import.meta.url));
const EVALUACION_EJEMPLO = fileURLToPath(new URL('../paquetes/nucleo/src/banco/evaluacion-ejemplo.json', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'umbral-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function correr(args: string[]) {
  return ejecutar('node', ['--import', 'tsx', SCRIPT, ...args], { timeout: 60000 }).then(
    (r) => ({ codigo: 0, salida: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ codigo: e.code, salida: e.stdout + e.stderr }),
  );
}

const banco = join(dir, 'banco.json');
const evaluacion = join(dir, 'evaluacion.json');
copyFileSync(BANCO_EJEMPLO, banco);
copyFileSync(EVALUACION_EJEMPLO, evaluacion);
const base = [`--banco=${banco}`, `--evaluacion=${evaluacion}`, '--proveedor=simulado'];

describe('medir-umbral-banco', { timeout: 60000 }, () => {
  it('imprime solo conteos, umbral, modelo, dimensión y SHA-256, sin texto de casos ni del banco', async () => {
    const r = await correr(base);
    expect(r.codigo).toBe(0);
    expect(r.salida).toMatch(/^banco_sha256=[0-9a-f]{64}$/m);
    expect(r.salida).toMatch(/^evaluacion_sha256=[0-9a-f]{64}$/m);
    expect(r.salida).toContain('modelo=simulado dimension=64');
    expect(r.salida).toMatch(/^umbral_fijo=\S+ umbral_derivacion=\S+ margen=\S+$/m);
    expect(r.salida).toMatch(/^calibracion total=\d+ aciertos=\d+ confusiones=0 /m);
    expect(r.salida).toMatch(/^control total=\d+ /m);
    expect(r.salida).toContain(
      'minimos calibracion_minimo_por_entrada=5 calibracion_casos_ninguna=32 control_minimo_por_entrada=5 control_casos_ninguna=32 cumple=true',
    );
    expect(r.salida).not.toContain('undefined');
    // El proveedor simulado elige el piso del barrido (0,50): el informe lo advierte.
    expect(r.salida).toContain('umbral_fijo=0.5 ');
    expect(r.salida).toContain('umbral_en_piso=true');
    expect(r.salida).toContain('resultado=valido');
    // Ningún texto de los archivos aparece en la salida.
    const textos = [
      ...(JSON.parse(readFileSync(evaluacion, 'utf8')) as { casos: Array<{ texto: string }> }).casos.map((c) => c.texto),
      ...(JSON.parse(readFileSync(banco, 'utf8')) as { respuestas: Array<{ preguntas: string[]; plantilla: string }> }).respuestas.flatMap((x) => [...x.preguntas, x.plantilla]),
    ];
    for (const t of textos) expect(r.salida).not.toContain(t);
    expect(r.salida).not.toContain('sintetico');
    expect(r.salida).not.toContain('ejemplo');
  });

  it('rechaza un banco o una evaluación dentro del repositorio con código 1, sin leerlos', async () => {
    const r1 = await correr([`--banco=${BANCO_EJEMPLO}`, `--evaluacion=${evaluacion}`, '--proveedor=simulado']);
    expect(r1.codigo).toBe(1);
    expect(r1.salida).toContain('fuera del repositorio');
    expect(r1.salida).not.toContain('banco_sha256');
    const r2 = await correr([`--banco=${banco}`, `--evaluacion=${EVALUACION_EJEMPLO}`, '--proveedor=simulado']);
    expect(r2.codigo).toBe(1);
    expect(r2.salida).not.toContain('banco_sha256');
  });

  it('rechaza el banco sintético con otro proveedor que no sea el simulado', async () => {
    const salidaBase = (await correr(base)).salida;
    const sha = /banco_sha256=([0-9a-f]{64})/.exec(salidaBase)?.[1] ?? '';
    const shaEv = /evaluacion_sha256=([0-9a-f]{64})/.exec(salidaBase)?.[1] ?? '';
    // Con vertex no llega a la red: el banco sintético se rechaza antes de crear el cliente.
    const r = await correr([`--banco=${banco}`, `--evaluacion=${evaluacion}`, '--proveedor=vertex', `--sha256=${sha}`, `--sha256-evaluacion=${shaEv}`]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('banco sintético fuera de pruebas');
    expect(r.salida).not.toContain('banco_sha256');
  });

  it('exige --sha256 y --sha256-evaluacion con vertex y rechaza argumentos incorrectos con código 2', async () => {
    expect((await correr([`--banco=${banco}`, `--evaluacion=${evaluacion}`, '--proveedor=vertex'])).codigo).toBe(2);
    expect((await correr([`--banco=${banco}`, `--evaluacion=${evaluacion}`, '--proveedor=vertex', `--sha256=${'a'.repeat(64)}`])).codigo).toBe(2);
    expect((await correr([`--banco=${banco}`, `--evaluacion=${evaluacion}`, '--proveedor=vertex', `--sha256-evaluacion=${'a'.repeat(64)}`])).codigo).toBe(2);
    const sinEvaluacion = await correr([`--banco=${banco}`, '--proveedor=simulado']);
    expect(sinEvaluacion.codigo).toBe(2);
    expect(sinEvaluacion.salida).toContain('--sha256-evaluacion');
    expect((await correr([...base, '--margen=2'])).codigo).toBe(2);
    expect((await correr([...base, '--margen='])).codigo).toBe(2);
    expect((await correr([...base, '--diferencia-derivacion='])).codigo).toBe(2);
    expect((await correr([...base, '--margen=  '])).codigo).toBe(2);
    expect((await correr([`--banco=${banco}`, `--evaluacion=${evaluacion}`, '--proveedor=otro'])).codigo).toBe(2);
  });

  it('un SHA-256 distinto falla con código 1 sin mostrar hashes', async () => {
    const r = await correr([...base, `--sha256=${'a'.repeat(64)}`]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('sha256 no coincide');
    expect(r.salida).not.toMatch(/[0-9a-f]{64}/);
  });

  it('una evaluación inválida falla con código 1 sin repetir su contenido', async () => {
    const mala = join(dir, 'mala.json');
    writeFileSync(mala, JSON.stringify({ formato: 1, version: '1.0.0', casos: [{ id: 'caso-uno', texto: 'TEXTO-SINTETICO-SECRETO', esperado: { tipo: 'respuesta', entradaId: 'no-existe' }, particion: 'control' }] }));
    const r = await correr([`--banco=${banco}`, `--evaluacion=${mala}`, '--proveedor=simulado']);
    expect(r.codigo).toBe(1);
    expect(r.salida).not.toContain('TEXTO-SINTETICO-SECRETO');
  });

  it('un SHA-256 de la evaluación distinto falla con código 1 sin mostrar hashes', async () => {
    const r = await correr([...base, `--sha256-evaluacion=${'b'.repeat(64)}`]);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('sha256 no coincide');
    expect(r.salida).not.toMatch(/[0-9a-f]{64}/);
  });

  it('rechaza un texto de caso con forma de secreto, dando solo la ruta del campo', async () => {
    const secreto = `sk-${'a1B2c3D4'.repeat(4)}`;
    const conSecreto = join(dir, 'secreto.json');
    writeFileSync(conSecreto, JSON.stringify({ formato: 1, version: '1.0.0', casos: [{ id: 'caso-uno', texto: `clave ${secreto}`, esperado: { tipo: 'ninguna' }, particion: 'control' }] }));
    const r = await correr([`--banco=${banco}`, `--evaluacion=${conSecreto}`, '--proveedor=simulado']);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('casos.0.texto: el valor parece un secreto');
    expect(r.salida).not.toContain(secreto);
  });

  it('solo admite archivos regulares de hasta 20 MiB', async () => {
    const carpeta = join(dir, 'carpeta.json');
    mkdirSync(carpeta);
    const r1 = await correr([`--banco=${carpeta}`, `--evaluacion=${evaluacion}`, '--proveedor=simulado']);
    expect(r1.codigo).toBe(1);
    expect(r1.salida).toContain('archivo no admitido');
    const grande = join(dir, 'grande.json');
    writeFileSync(grande, '');
    truncateSync(grande, 20 * 1024 * 1024 + 1);
    const r2 = await correr([`--banco=${banco}`, `--evaluacion=${grande}`, '--proveedor=simulado']);
    expect(r2.codigo).toBe(1);
    expect(r2.salida).toContain('archivo no admitido');
  });

  it('un error de sistema imprime solo su nombre y código, nunca su mensaje ni la ruta', async () => {
    const inexistente = join(dir, 'no-existe-RUTA-SECRETA.json');
    const r = await correr([`--banco=${inexistente}`, `--evaluacion=${evaluacion}`, '--proveedor=simulado']);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('Error no detallado: Error código=ENOENT');
    expect(r.salida).not.toContain('RUTA-SECRETA');
  });

  it('con los mínimos de D8 sin cumplir en la calibración informa minimos_calibracion_insuficientes', async () => {
    const pocos = join(dir, 'pocos.json');
    writeFileSync(pocos, JSON.stringify({ formato: 1, version: '1.0.0', casos: [{ id: 'caso-uno', texto: 'texto sintetico uno', esperado: { tipo: 'ninguna' }, particion: 'control' }] }));
    const r = await correr([`--banco=${banco}`, `--evaluacion=${pocos}`, '--proveedor=simulado']);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('calibracion_minimo_por_entrada=0 calibracion_casos_ninguna=0 control_minimo_por_entrada=0 control_casos_ninguna=1 cumple=false');
    expect(r.salida).toContain('resultado=minimos_calibracion_insuficientes');
    expect(r.salida).not.toContain('sin_umbral_factible');
  });

  it('informa umbral_en_piso=true también cuando el umbral de derivación queda bajo el piso', async () => {
    // Un caso «ninguna» casi idéntico a una pregunta del banco obliga a subir el umbral fijo por encima del piso.
    const crudo = JSON.parse(readFileSync(evaluacion, 'utf8')) as { casos: Array<{ id: string; texto: string; esperado: { tipo: string }; particion: string }> };
    const cercano = crudo.casos.find((c) => c.esperado.tipo === 'ninguna' && c.particion === 'calibracion');
    if (!cercano) throw new Error('el ejemplo debe tener casos «ninguna»');
    cercano.texto = 'pregunta sintetica de contacto extra';
    const subido = join(dir, 'subido.json');
    writeFileSync(subido, JSON.stringify(crudo));
    const sin = await correr([`--banco=${banco}`, `--evaluacion=${subido}`, '--proveedor=simulado']);
    expect(sin.salida).toMatch(/^umbral_fijo=0\.[6-9]\d* /m);
    expect(sin.salida).not.toContain('umbral_en_piso');
    const con = await correr([`--banco=${banco}`, `--evaluacion=${subido}`, '--proveedor=simulado', '--diferencia-derivacion=0.45']);
    expect(con.salida).toMatch(/^umbral_fijo=0\.[6-9]\d* umbral_derivacion=0\.[0-4]\d* /m);
    expect(con.salida).toContain('umbral_en_piso=true');
  });

  it('un FIFO no bloquea la apertura: se rechaza como archivo no admitido', async () => {
    const fifo = join(dir, 'tuberia.json');
    execFileSync('mkfifo', [fifo]);
    const r = await correr([`--banco=${fifo}`, `--evaluacion=${evaluacion}`, '--proveedor=simulado']);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('archivo no admitido');
  });
});
