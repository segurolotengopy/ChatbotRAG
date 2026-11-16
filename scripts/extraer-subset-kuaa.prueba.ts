/**
 * Pruebas del extractor del subset de Kuaa. No copian nada ni usan la red: ejercitan la lista blanca y las exclusiones
 * con `--simular` (que solo imprime la lista) y el rechazo de destinos inválidos. La extracción completa con
 * instalación, tipos y pruebas se corre a mano con `--verificar` (tarda decenas de segundos y necesita el store de pnpm).
 */
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';

const ejecutar = promisify(execFile);
const SCRIPT = fileURLToPath(new URL('./extraer-subset-kuaa.mts', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'subset-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function correr(args: string[]) {
  return ejecutar('node', ['--import', 'tsx', SCRIPT, ...args], { timeout: 60000 }).then(
    (r) => ({ codigo: 0, salida: r.stdout + r.stderr }),
    (e: { code: number; stdout: string; stderr: string }) => ({ codigo: e.code, salida: e.stdout + e.stderr }),
  );
}

describe('extraer-subset-kuaa: lista blanca y exclusiones', () => {
  let lista: string[] = [];
  it('imprime la lista de archivos sin escribir nada', async () => {
    const r = await correr([join(dir, 'destino-simulado'), '--simular']);
    expect(r.codigo).toBe(0);
    lista = r.salida.split('\n').filter((l) => l.length > 0);
    expect(lista.length).toBeGreaterThan(50);
  });

  it('incluye lo que Kuaa necesita', () => {
    for (const ruta of [
      'paquetes/nucleo/src/oportunidad/agente-kuaa.ts',
      'paquetes/nucleo/src/orquestador/peticion.ts',
      'paquetes/nucleo/src/compuertas/salida.ts',
      'paquetes/proveedor-vertex/package.json',
      'paquetes/conocimiento-gcs/package.json',
      'servicio/src/entorno.ts',
      'configuraciones/kuaa.json',
      'scripts/preparar-paquete-kuaa.mts',
      'Dockerfile',
      'deploy.sh',
      'security-local.sh',
      'docs/MONITOREO.md',
      '.github/workflows/ci-node-cloudrun.yml',
      'overlay:servicio/src/armar-agentes.ts',
      'overlay:servicio/src/aplicacion.ts',
      'overlay:servicio/src/principal.ts',
      'overlay:.devsecops.yml',
    ]) {
      expect(lista, ruta).toContain(ruta);
    }
  });

  it('excluye historia, otros clientes, nubes recortadas e integraciones', () => {
    const prohibidos = [
      /^ESTADO\.md$/,
      /^configuraciones\/(segurolotengo|comercio-agendamiento)\.json$/,
      /^configuraciones\/corpus\//,
      /^integraciones\//,
      /^paquetes\/(proveedor-bedrock|conocimiento-pgvector|canal-web)\//,
      /^servicio\/src\/herramientas-http\.ts$/,
      /^servicio\/src\/aplicacion\.prueba\.ts$/,
      /^servicio\/src\/(alcance|corpus|manuales)-segurolotengo\.prueba\.ts$/,
      /^\.github\/CODEOWNERS$/,
      /^\.claude\//,
      /^CLAUDE\.md$/,
      /^docs\/(ARQUITECTURA|COSTOS-GCP|GUIA-DESPLIEGUE-GCP|INFORME-ESTANDAR-DEVSECOPS)\.md$/,
      /(^|\/)\.git(\/|$)/,
      /(^|\/)node_modules\//,
    ];
    for (const ruta of lista.filter((l) => !l.startsWith('overlay:'))) {
      for (const p of prohibidos) expect(ruta, `${ruta} coincide con ${p.source}`).not.toMatch(p);
    }
  });
});

describe('extraer-subset-kuaa: destinos inválidos', () => {
  it('rechaza un destino existente y no vacío', async () => {
    writeFileSync(join(dir, 'ocupado.txt'), 'x');
    const r = await correr([dir]);
    expect(r.codigo).toBe(2);
    expect(r.salida).toContain('no está vacío');
  });

  it('rechaza un destino dentro del repositorio', async () => {
    const raiz = fileURLToPath(new URL('..', import.meta.url));
    const r = await correr([join(raiz, 'subset-no-debe-existir')]);
    expect(r.codigo).toBe(2);
    expect(r.salida).toContain('dentro del repositorio');
  });

  it('rechaza un destino que contiene al repositorio', async () => {
    const r = await correr([fileURLToPath(new URL('../..', import.meta.url))]);
    expect(r.codigo).toBe(2);
  });

  it('sin destino termina con uso', async () => {
    const r = await correr([]);
    expect(r.codigo).toBe(2);
    expect(r.salida).toContain('Uso:');
  });
});
