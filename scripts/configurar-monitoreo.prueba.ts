/**
 * PRUEBA DE scripts/configurar-monitoreo.sh
 *
 * El script maneja dos claves de API y los UUID de los chequeos, que son secretos en
 * un repositorio público. Lo que más importa probar es lo que NO debe pasar: que un
 * valor secreto aparezca en la salida, que `plan` escriba algo, que se borre lo que
 * no se nombró o que se acepte un archivo de clave legible por otros. Se ejecuta de
 * verdad con `curl` y `gh` simulados al frente del PATH.
 *
 * Qué NO garantiza: no habla con Healthchecks, Better Stack ni GitHub; la forma de
 * las respuestas se toma de su documentación oficial (consultada el 2026-10-12), y
 * el host de la API de Better Stack debe confirmarse con la primera lectura real.
 */
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./configurar-monitoreo.sh', import.meta.url));
const CLAVE_HC = 'CLAVE-HC-SECRETA-123';
const TOKEN_BS = 'TOKEN-BS-SECRETO-456';
const UUID_PRUEBA = 'UUID-DEL-CHEQUEO-DE-PRUEBA';
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Opciones {
  bsExistentes?: Array<{ id: string; pronounceable_name: string; url: string }>;
  hcExistentes?: Array<{ name: string; uuid: string; last_ping: string | null }>;
  modoClaveHc?: number;
  codigoListaHc?: number;
  url?: string;
}

interface Resultado {
  codigo: number;
  salida: string;
  llamadas: string[];
  gh: string[];
  entradasGh: string[];
  datos: string[];
}

function ejecutar(args: string[], o: Opciones = {}): Promise<Resultado> {
  const dir = mkdtempSync(join(tmpdir(), 'cfgmon-'));
  dirs.push(dir);
  const hc = { checks: o.hcExistentes ?? [{ name: 'My First Check', uuid: UUID_PRUEBA, last_ping: null }] };
  const bs = { data: (o.bsExistentes ?? []).map((m) => ({ id: m.id, type: 'monitor', attributes: { pronounceable_name: m.pronounceable_name, url: m.url, monitor_type: 'keyword', status: 'up' } })) };
  writeFileSync(join(dir, 'hc-lista.json'), JSON.stringify(hc));
  writeFileSync(join(dir, 'bs-lista.json'), JSON.stringify(bs));
  writeFileSync(join(dir, 'hc-clave'), CLAVE_HC);
  writeFileSync(join(dir, 'bs-token'), TOKEN_BS);
  chmodSync(join(dir, 'hc-clave'), o.modoClaveHc ?? 0o600);
  chmodSync(join(dir, 'bs-token'), 0o600);

  // curl simulado: registra «METODO URL», guarda el cuerpo enviado y responde según la ruta.
  writeFileSync(
    join(dir, 'curl'),
    `#!/usr/bin/env bash
salida=""; metodo="GET"; datos=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) salida="$2"; shift 2 ;;
    -X) metodo="$2"; shift 2 ;;
    --data) datos="$2"; shift 2 ;;
    -w|--max-time|-H) shift 2 ;;
    -sS) shift ;;
    *) url="$1"; shift ;;
  esac
done
echo "$metodo $url" >> "${dir}/llamadas.txt"
[ -n "$datos" ] && echo "$datos" >> "${dir}/datos.txt"
case "$metodo $url" in
  "GET https://healthchecks.io/api/v3/checks/")
    cat "${dir}/hc-lista.json" > "$salida"; printf '${o.codigoListaHc ?? 200}' ;;
  "POST https://healthchecks.io/api/v3/checks/")
    nombre=$(echo "$datos" | jq -r .name); printf '{"uuid":"UUID-NUEVO-%s"}' "$nombre" > "$salida"; printf '201' ;;
  "GET https://uptime.betterstack.com/api/v2/monitors")
    cat "${dir}/bs-lista.json" > "$salida"; printf '200' ;;
  "POST https://uptime.betterstack.com/api/v2/monitors")
    printf '{"data":{"id":"1"}}' > "$salida"; printf '201' ;;
  DELETE*) printf '{}' > "$salida"; printf '200' ;;
  *) printf '{}' > "$salida"; printf '404' ;;
esac
`,
  );
  // gh simulado: registra el subcomando y lo que llegó por la entrada estándar.
  writeFileSync(
    join(dir, 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/gh.txt"
if [ "$1 $2" = "secret set" ]; then echo "$3 <= $(cat)" >> "${dir}/gh-stdin.txt"; fi
`,
  );
  chmodSync(join(dir, 'curl'), 0o755);
  chmodSync(join(dir, 'gh'), 0o755);

  const leer = (n: string): string[] => (existsSync(join(dir, n)) ? readFileSync(join(dir, n), 'utf8').split('\n').filter(Boolean) : []);
  return new Promise((resolver) => {
    execFile(
      'bash',
      [SCRIPT, ...args],
      {
        env: {
          PATH: `${dir}:${process.env['PATH'] ?? ''}`,
          HOME: dir,
          HC_API_KEY_FILE: join(dir, 'hc-clave'),
          BS_API_TOKEN_FILE: join(dir, 'bs-token'),
          URL_STAGING: o.url ?? 'https://chatbotrag-ejemplo.a.run.app',
          REPO: 'org/repo',
        },
      },
      (err, stdout, stderr) =>
        resolver({
          codigo: err ? (((err as NodeJS.ErrnoException).code as unknown as number) ?? 1) : 0,
          salida: `${stdout}${stderr}`,
          llamadas: leer('llamadas.txt'),
          gh: leer('gh.txt'),
          entradasGh: leer('gh-stdin.txt'),
          datos: leer('datos.txt'),
        }),
    );
  });
}

const sinSecretos = (s: string): void => {
  for (const secreto of [CLAVE_HC, TOKEN_BS, UUID_PRUEBA, 'UUID-NUEVO']) expect(s).not.toContain(secreto);
};

describe('configurar-monitoreo: plan', () => {
  it('solo lee: no hace POST ni DELETE ni llama a gh, y muestra nombres sin secretos', async () => {
    const r = await ejecutar(['plan']);
    expect(r.codigo).toBe(0);
    expect(r.llamadas.every((l) => l.startsWith('GET '))).toBe(true);
    expect(r.gh).toEqual([]);
    expect(r.salida).toContain('My First Check');
    expect(r.salida).toContain('nada se escribió');
    sinSecretos(r.salida);
  });
});

describe('configurar-monitoreo: aplicar', () => {
  it('crea los dos chequeos y el monitor, carga variable y secretos, y no imprime ningún secreto', async () => {
    const r = await ejecutar(['aplicar']);
    expect(r.codigo).toBe(0);
    const posts = r.llamadas.filter((l) => l.startsWith('POST '));
    expect(posts).toHaveLength(3);
    expect(r.datos.join('\n')).toContain('"name":"sonda-15min","tags":"chatbotrag staging","timeout":900,"grace":1800');
    expect(r.datos.join('\n')).toContain('"timeout":86400,"grace":14400');
    expect(r.datos.join('\n')).toContain('"monitor_type":"keyword"');
    expect(r.datos.join('\n')).toContain('"check_frequency":180');
    expect(r.datos.join('\n')).toContain('https://chatbotrag-ejemplo.a.run.app/salud');
    // El UUID llegó a gh por la entrada estándar, no por argumentos.
    expect(r.entradasGh).toEqual(['HEALTHCHECKS_PING_SONDA <= UUID-NUEVO-sonda-15min', 'HEALTHCHECKS_PING_REPORTE <= UUID-NUEVO-reporte-diario']);
    expect(r.gh.join('\n')).not.toContain('UUID-NUEVO');
    expect(r.gh.some((g) => g.startsWith('variable set URL_STAGING') && g.includes('--repo org/repo'))).toBe(true);
    sinSecretos(r.salida);
  });

  it('no duplica el monitor de Better Stack si ya existe', async () => {
    const r = await ejecutar(['aplicar'], { bsExistentes: [{ id: '9', pronounceable_name: 'ChatbotRAG staging /salud', url: 'https://x/salud' }] });
    expect(r.codigo).toBe(0);
    expect(r.llamadas.filter((l) => l === 'POST https://uptime.betterstack.com/api/v2/monitors')).toHaveLength(0);
    expect(r.salida).toContain('ya existe');
  });

  it('borra solo lo que se nombra', async () => {
    const r = await ejecutar(['aplicar', '--borrar-hc', 'My First Check', '--borrar-bs', '77'], {
      hcExistentes: [
        { name: 'My First Check', uuid: UUID_PRUEBA, last_ping: null },
        { name: 'otro-chequeo-ajeno', uuid: 'UUID-AJENO', last_ping: '2026-10-12' },
      ],
    });
    expect(r.codigo).toBe(0);
    const borrados = r.llamadas.filter((l) => l.startsWith('DELETE '));
    expect(borrados).toEqual([`DELETE https://healthchecks.io/api/v3/checks/${UUID_PRUEBA}`, 'DELETE https://uptime.betterstack.com/api/v2/monitors/77']);
    expect(r.salida).not.toContain('UUID-AJENO');
    sinSecretos(r.salida);
  });

  it('un nombre que no existe no borra nada', async () => {
    const r = await ejecutar(['aplicar', '--borrar-hc', 'No Existe']);
    expect(r.llamadas.filter((l) => l.startsWith('DELETE '))).toEqual([]);
    expect(r.salida).toContain('nada que borrar');
  });

  it('rechaza un id de Better Stack que no sea numérico', async () => {
    const r = await ejecutar(['aplicar', '--borrar-bs', '1; rm -rf /']);
    expect(r.codigo).toBe(2);
    expect(r.llamadas.filter((l) => l.startsWith('DELETE '))).toEqual([]);
  });
});

describe('configurar-monitoreo: salvaguardas', () => {
  it('se niega si el archivo de la clave es legible por otros', async () => {
    const r = await ejecutar(['plan'], { modoClaveHc: 0o644 });
    expect(r.codigo).toBe(2);
    expect(r.salida).toContain('modo 600 o 400');
    expect(r.llamadas).toEqual([]);
    sinSecretos(r.salida);
  });

  it('si la lectura de Healthchecks falla, termina con 1 sin escribir ni filtrar secretos', async () => {
    const r = await ejecutar(['aplicar'], { codigoListaHc: 401 });
    expect(r.codigo).toBe(1);
    expect(r.llamadas.filter((l) => l.startsWith('POST ') || l.startsWith('DELETE '))).toEqual([]);
    expect(r.gh).toEqual([]);
    sinSecretos(r.salida);
  });

  it.each(['', 'http://x.example', 'https://x.example/ruta'])('rechaza la URL inválida «%s»', async (url) => {
    const r = await ejecutar(['plan'], { url });
    expect(r.codigo).toBe(2);
  });

  it('exige el modo plan o aplicar', async () => {
    const r = await ejecutar(['otro']);
    expect(r.codigo).toBe(2);
  });
});
