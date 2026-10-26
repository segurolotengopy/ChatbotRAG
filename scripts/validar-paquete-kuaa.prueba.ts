/**
 * Prueba del validador de paquetes de Kuaa con fixtures sintéticos en un directorio
 * temporal. Comprueba que solo se imprimen conteos y que --exigir-habilitados falla
 * cuando no hay registros habilitados.
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const ejecutar = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./validar-paquete-kuaa.mts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'kuaa-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function correr(args: string[]) {
  return ejecutar('node', ['--import', 'tsx', SCRIPT, ...args], { timeout: 60000 }).then(
    (r) => ({ codigo: 0, salida: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ codigo: e.code, salida: e.stdout + e.stderr }),
  );
}

const sinHabilitar = join(dir, 'a.json');
const conHabilitado = join(dir, 'b.json');
const roto = join(dir, 'c.json');
writeFileSync(sinHabilitar, JSON.stringify([{ t: 'TEXTO-SINTETICO-1', habilitado_produccion: false }, { habilitado_produccion: 'true' }, {}]));
writeFileSync(conHabilitado, JSON.stringify([{ t: 'TEXTO-SINTETICO-2', habilitado_produccion: true }]));
writeFileSync(roto, '{no es json');

describe('validar-paquete-kuaa', () => {
  it('imprime conteos y nunca contenido', async () => {
    const r = await correr([sinHabilitar, conHabilitado]);
    expect(r.codigo).toBe(0);
    expect(r.salida).toContain('total=3 habilitados=0 rechazados=3 (no_habilitado=1 valor_no_booleano=1 campo_ausente=1');
    expect(r.salida).toContain('total=1 habilitados=1');
    expect(r.salida).not.toContain('TEXTO-SINTETICO');
  });
  it('--exigir-habilitados falla si no hay ninguno', async () => {
    expect((await correr(['--exigir-habilitados', sinHabilitar])).codigo).toBe(1);
    expect((await correr(['--exigir-habilitados', sinHabilitar, conHabilitado])).codigo).toBe(0);
  });
  it('un archivo ilegible falla y sin argumentos sale con 2', async () => {
    expect((await correr([roto])).codigo).toBe(1);
    expect((await correr([])).codigo).toBe(2);
  });
});
