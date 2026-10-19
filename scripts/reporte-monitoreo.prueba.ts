/**
 * PRUEBA DEL REPORTE DIARIO (scripts/reporte-monitoreo.sh)
 *
 * El reporte es la prueba periódica de que el monitor sigue vivo; si muere en
 * silencio, nadie se entera. Se ejecuta de verdad con un `gh` y un `curl` simulados
 * (un directorio con ejecutables falsos al frente del PATH) y se comprueba lo que
 * publica, qué cuenta y que NO publique nada cuando falta el issue.
 *
 * Qué NO garantiza: no habla con la API real de GitHub ni de Healthchecks; la forma
 * del JSON de `gh run list` se toma de su documentación.
 */
import { execFile } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./reporte-monitoreo.sh', import.meta.url));
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Escenario {
  corridas: Array<{ conclusion: string; status: string }>;
  issues: Array<{ number: number; title: string }>;
  ping?: string;
}

function ejecutar(e: Escenario): Promise<{ codigo: number; salida: string; comentario: string | null; pings: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'reporte-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'corridas.json'), JSON.stringify(e.corridas));
  writeFileSync(join(dir, 'issues.json'), JSON.stringify(e.issues));
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
case "$1 $2" in
  "run list") cat "${dir}/corridas.json" ;;
  "issue list") cat "${dir}/issues.json" ;;
  "issue comment") while [ $# -gt 0 ]; do [ "$1" = "--body" ] && printf '%s' "$2" > "${dir}/comentario.txt"; shift; done ;;
  *) echo "gh simulado: llamada inesperada $*" >&2; exit 9 ;;
esac
`,
  );
  writeFileSync(join(dir, 'curl'), `#!/usr/bin/env bash\necho "$@" >> "${dir}/pings.txt"\n`);
  chmodSync(join(dir, 'gh'), 0o755);
  chmodSync(join(dir, 'curl'), 0o755);

  return new Promise((resolver) => {
    execFile(
      'bash',
      [SCRIPT],
      { env: { PATH: `${dir}:${process.env['PATH'] ?? ''}`, GITHUB_REPOSITORY: 'org/repo', GH_TOKEN: 'x', ...(e.ping ? { PING: e.ping } : {}) } },
      (err, stdout, stderr) => {
        const archivo = join(dir, 'comentario.txt');
        const pings = join(dir, 'pings.txt');
        resolver({
          codigo: err ? (((err as NodeJS.ErrnoException).code as unknown as number) ?? 1) : 0,
          salida: `${stdout}${stderr}`,
          comentario: existsSync(archivo) ? readFileSync(archivo, 'utf8') : null,
          pings: existsSync(pings) ? readFileSync(pings, 'utf8') : '',
        });
      },
    );
  });
}

const ok = (n: number) => Array.from({ length: n }, () => ({ conclusion: 'success', status: 'completed' }));
const ISSUE = [{ number: 7, title: 'Monitoreo staging' }];

describe('reporte diario del monitoreo', () => {
  it('cuenta exitosas, fallidas, otras y faltantes, y las comenta en el issue', async () => {
    const corridas = [
      ...ok(90),
      { conclusion: 'failure', status: 'completed' },
      { conclusion: 'timed_out', status: 'completed' },
      { conclusion: 'cancelled', status: 'completed' },
    ];
    const r = await ejecutar({ corridas, issues: ISSUE });
    expect(r.codigo).toBe(0);
    expect(r.comentario).toContain('| 96 | 93 | 90 | 2 | 1 | 3 |');
  });

  it('con las 96 corridas no hay faltantes', async () => {
    const r = await ejecutar({ corridas: ok(96), issues: ISSUE });
    expect(r.comentario).toContain('| 96 | 96 | 96 | 0 | 0 | 0 |');
  });

  it('más corridas que las esperadas no da faltantes negativos', async () => {
    const r = await ejecutar({ corridas: ok(100), issues: ISSUE });
    expect(r.comentario).toContain('| 96 | 100 | 100 | 0 | 0 | 0 |');
  });

  it('sin el issue FALLA y no publica nada ni avisa al latido', async () => {
    const r = await ejecutar({ corridas: ok(96), issues: [{ number: 3, title: 'Otro asunto' }], ping: 'uuid-de-prueba' });
    expect(r.codigo).toBe(1);
    expect(r.salida).toContain('Una persona debe crearlo');
    expect(r.comentario).toBeNull();
    expect(r.pings).toBe('');
  });

  it('con el secreto avisa al latido solo después de publicar', async () => {
    const r = await ejecutar({ corridas: ok(96), issues: ISSUE, ping: 'uuid-de-prueba' });
    expect(r.codigo).toBe(0);
    expect(r.comentario).not.toBeNull();
    expect(r.pings).toContain('https://hc-ping.com/uuid-de-prueba');
  });

  it('sin el secreto publica igual y deja un aviso visible', async () => {
    const r = await ejecutar({ corridas: ok(96), issues: ISSUE });
    expect(r.codigo).toBe(0);
    expect(r.salida).toContain('Falta el secreto HEALTHCHECKS_PING_REPORTE');
    expect(r.pings).toBe('');
  });
});
