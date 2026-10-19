/**
 * PRUEBA DE scripts/guardar-claves-monitoreo.sh
 *
 * Lo que importa es lo que NO debe pasar: que la clave se muestre, que viaje en la
 * línea de comandos de `curl` (visible para otros procesos), que se guarde una clave
 * rechazada o de solo lectura, que el archivo quede legible por otros o que se
 * sobrescriba una clave existente sin pedirlo. Se ejecuta de verdad con un `curl`
 * simulado y la clave entra por la entrada estándar, como la teclearía una persona.
 *
 * Qué NO garantiza: no habla con Healthchecks ni con Better Stack.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./guardar-claves-monitoreo.sh', import.meta.url));
const CLAVE = 'clave_de_prueba-ABCDEF123456';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opciones {
  codigo?: number;
  cuerpo?: string;
  preexistente?: string;
}

function ejecutar(args: string[], entrada: string, o: Opciones = {}): Promise<{ codigo: number; salida: string; dir: string; argvCurl: string }> {
  const base = mkdtempSync(join(tmpdir(), 'claves-'));
  dirs.push(base);
  const config = join(base, 'cfg');
  if (o.preexistente !== undefined) {
    // crea el directorio y un archivo previo
    execFile('mkdir', ['-p', config]);
  }
  writeFileSync(join(base, 'cuerpo.json'), o.cuerpo ?? '{"checks":[{"name":"x","uuid":"u"}]}');
  writeFileSync(
    join(base, 'curl'),
    `#!/usr/bin/env bash
echo "$*" >> "${base}/argv.txt"
while [ $# -gt 0 ]; do case "$1" in -o) cp "${base}/cuerpo.json" "$2"; shift 2 ;; *) shift ;; esac; done
printf '${o.codigo ?? 200}'
`,
  );
  chmodSync(join(base, 'curl'), 0o755);
  if (o.preexistente !== undefined) {
    execFile('bash', ['-c', `mkdir -p "${config}" && printf '%s' "${o.preexistente}" > "${config}/healthchecks-api-key" && chmod 600 "${config}/healthchecks-api-key"`]);
  }
  return new Promise((resolver) => {
    // pequeña espera para que el mkdir/printf asíncrono del preexistente termine
    setTimeout(() => {
      const hijo = execFile('bash', [SCRIPT, ...args], { env: { PATH: `${base}:${process.env['PATH'] ?? ''}`, CHATBOTRAG_CONFIG_DIR: config, HOME: base } }, (err, stdout, stderr) =>
        resolver({
          codigo: err ? (((err as NodeJS.ErrnoException).code as unknown as number) ?? 1) : 0,
          salida: `${stdout}${stderr}`,
          dir: config,
          argvCurl: existsSync(join(base, 'argv.txt')) ? readFileSync(join(base, 'argv.txt'), 'utf8') : '',
        }),
      );
      hijo.stdin?.end(entrada);
    }, 150);
  });
}

const modo = (ruta: string): string => (statSync(ruta).mode & 0o777).toString(8);

describe('guardar-claves-monitoreo: Healthchecks', () => {
  it('guarda la clave válida con modo 600 en un directorio 700, sin mostrarla ni ponerla en curl', async () => {
    const r = await ejecutar(['healthchecks'], `${CLAVE}\n`);
    expect(r.codigo).toBe(0);
    const archivo = join(r.dir, 'healthchecks-api-key');
    expect(readFileSync(archivo, 'utf8')).toBe(CLAVE);
    expect(modo(archivo)).toBe('600');
    expect(modo(r.dir)).toBe('700');
    expect(r.salida).not.toContain(CLAVE);
    expect(r.argvCurl).not.toContain(CLAVE);
  });

  it('rechaza una clave de solo lectura (trae unique_key) y no guarda nada', async () => {
    const r = await ejecutar(['healthchecks'], `${CLAVE}\n`, { cuerpo: '{"checks":[{"name":"x","unique_key":"k"}]}' });
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('SOLO LECTURA');
    expect(existsSync(join(r.dir, 'healthchecks-api-key'))).toBe(false);
    expect(r.salida).not.toContain(CLAVE);
  });

  it('no guarda una clave que el servicio rechaza', async () => {
    const r = await ejecutar(['healthchecks'], `${CLAVE}\n`, { codigo: 401 });
    expect(r.codigo).toBe(1);
    expect(existsSync(join(r.dir, 'healthchecks-api-key'))).toBe(false);
  });

  it.each(['', 'corta', 'con espacios dentro de la clave larga 123', 'clave;rm -rf /-ABCDEFGHIJKL'])('rechaza la forma inválida «%s»', async (clave) => {
    const r = await ejecutar(['healthchecks'], `${clave}\n`);
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('forma esperada');
    expect(existsSync(join(r.dir, 'healthchecks-api-key'))).toBe(false);
  });

  it('no sobrescribe una clave existente sin --reemplazar', async () => {
    const r = await ejecutar(['healthchecks'], `${CLAVE}\n`, { preexistente: 'VIEJA-CLAVE-1234567890' });
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('--reemplazar');
    expect(readFileSync(join(r.dir, 'healthchecks-api-key'), 'utf8')).toBe('VIEJA-CLAVE-1234567890');
  });

  it('con --reemplazar la sobrescribe', async () => {
    const r = await ejecutar(['healthchecks', '--reemplazar'], `${CLAVE}\n`, { preexistente: 'VIEJA-CLAVE-1234567890' });
    expect(r.codigo).toBe(0);
    expect(readFileSync(join(r.dir, 'healthchecks-api-key'), 'utf8')).toBe(CLAVE);
  });
});

describe('guardar-claves-monitoreo: Better Stack y uso', () => {
  it('guarda el token de Better Stack con modo 600 y sin mostrarlo', async () => {
    const r = await ejecutar(['betterstack'], `${CLAVE}\n`, { cuerpo: '{"data":[]}' });
    expect(r.codigo).toBe(0);
    const archivo = join(r.dir, 'betterstack-api-token');
    expect(readFileSync(archivo, 'utf8')).toBe(CLAVE);
    expect(modo(archivo)).toBe('600');
    expect(r.salida).not.toContain(CLAVE);
    expect(r.argvCurl).not.toContain(CLAVE);
  });

  it('rechaza un argumento desconocido', async () => {
    const r = await ejecutar(['otra-cosa'], '');
    expect(r.codigo).toBe(2);
  });
});
