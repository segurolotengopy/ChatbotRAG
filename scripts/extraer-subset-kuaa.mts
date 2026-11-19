/**
 * EXTRACTOR DEL SUBSET DE KUAA (bloque S2 del spin-off)
 *
 * Uso: node --import tsx scripts/extraer-subset-kuaa.mts <destino> [--verificar] [--simular] [--almacen=<dir>]
 *
 * Por qué existe: el servicio de Kuaa se entrega a otra organización como copia independiente. Copiar «todo menos lo
 * que recuerdo» arrastraría, tarde o temprano, un identificador de proyecto, una configuración de otro cliente o la
 * historia del repositorio. Aquí la regla es la inversa: se parte de la lista de archivos de git (jamás de `.git`) y solo
 * pasa lo que está en LA LISTA BLANCA; después una lista de exclusiones explícitas tiene prioridad sobre ella, y por último se
 * superpone `integraciones/kuaa-subset/overlay/` (servicio solo-Kuaa, tsconfig, Dockerfile, manifiesto con marcadores).
 *
 * Qué hace:
 *   1. Rechaza un destino que exista y no esté vacío, o que esté dentro de este repositorio.
 *   2. Copia la lista blanca menos las exclusiones y aplica el overlay.
 *   3. Escribe ORIGEN.md (commit y fecha de origen, si el árbol tenía cambios sin confirmar, qué se recortó).
 *   4. Comprueba que ningún archivo copiado mencione una pieza recortada (el recorte se prueba, no se supone).
 *   5. Con --verificar: `pnpm install --offline`, `pnpm tipos`, `pnpm pruebas` en el destino y una búsqueda de
 *      identificadores de AAB1 y de claves. Cualquier fallo termina con código 1.
 * `--almacen` fija el store de pnpm para la instalación sin red (si el destino está en otro sistema de archivos, pnpm
 * crea un store nuevo y vacío y la instalación offline falla).
 * Con --simular solo imprime la lista de archivos que se copiarían; no escribe nada.
 *
 * Qué NO garantiza: que el subset sea suficiente para producción (faltan los datos de Interseguros: manifiesto,
 * bucket, contacto) ni que la búsqueda de claves sea exhaustiva (patrones conocidos, no un escáner; para eso está
 * `./security-local.sh`). Lee el árbol de trabajo, no el commit: si hay cambios sin confirmar, ORIGEN.md lo declara.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const OVERLAY = join(RAIZ, 'integraciones', 'kuaa-subset', 'overlay');

/** Lista blanca por prefijo de directorio. */
const INCLUIR_PREFIJOS = ['paquetes/nucleo/', 'paquetes/proveedor-vertex/', 'paquetes/conocimiento-gcs/', 'servicio/', '.github/', 'scripts/__fixtures__/'];

/** Lista blanca por ruta exacta. */
const INCLUIR_EXACTOS = new Set([
  'configuraciones/kuaa.json',
  'scripts/tsconfig.json',
  'scripts/preparar-paquete-kuaa.mts',
  'scripts/preparar-paquete-kuaa.prueba.ts',
  'scripts/validar-paquete-kuaa.mts',
  'scripts/validar-paquete-kuaa.prueba.ts',
  'scripts/medir-umbral-banco.mts',
  'scripts/medir-umbral-banco.prueba.ts',
  'scripts/sondear-staging.sh',
  'scripts/sondear-staging.prueba.ts',
  'scripts/reporte-monitoreo.sh',
  'scripts/reporte-monitoreo.prueba.ts',
  'scripts/configurar-monitoreo.sh',
  'scripts/configurar-monitoreo.prueba.ts',
  'scripts/guardar-claves-monitoreo.sh',
  'scripts/guardar-claves-monitoreo.prueba.ts',
  'Dockerfile',
  'deploy.sh',
  'security-local.sh',
  'docs/MONITOREO.md',
  'tsconfig.base.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'tsconfig.json',
  'vitest.config.ts',
  'eslint.config.js',
  '.npmrc',
  '.gitignore',
  '.dockerignore',
  '.env.example',
  '.pre-commit-config.yaml',
]);

/**
 * Exclusiones explícitas: ganan sobre la lista blanca. Cada una lleva su motivo para que quien amplíe la lista vea
 * qué se decidió y por qué.
 */
export const EXCLUSIONES: ReadonlyArray<{ patron: RegExp; motivo: string }> = [
  { patron: /^ESTADO\.md$/, motivo: 'historia y estado de ChatbotRAG' },
  { patron: /^configuraciones\/(segurolotengo|comercio-agendamiento)\.json$/, motivo: 'agentes de ejemplo de otro cliente' },
  { patron: /^configuraciones\/corpus\//, motivo: 'corpus de otros agentes' },
  { patron: /^integraciones\//, motivo: 'integraciones de otro producto (el overlay se aplica aparte)' },
  { patron: /^paquetes\/(proveedor-bedrock|conocimiento-pgvector|canal-web)\//, motivo: 'nube, base o canal que el servicio de Kuaa no usa' },
  { patron: /^servicio\/src\/herramientas-http\.ts$/, motivo: 'herramientas http firmadas del agente genérico' },
  { patron: /^servicio\/src\/aplicacion\.prueba\.ts$/, motivo: 'prueba del agente genérico, sus rutas y sus herramientas' },
  { patron: /^servicio\/src\/(alcance|corpus|manuales)-segurolotengo\.prueba\.ts$/, motivo: 'pruebas del corpus y de la configuración de otro cliente' },
  { patron: /^paquetes\/nucleo\/src\/configuracion\/esquema\.prueba\.ts$/, motivo: 'recorre las configuraciones de otros agentes' },
  { patron: /^paquetes\/nucleo\/src\/compuertas\/normalizar\.prueba\.ts$/, motivo: 'recorre el corpus de otros agentes' },
  { patron: /^paquetes\/nucleo\/src\/compuertas\/entrada-sin-sujeto\.prueba\.ts$/, motivo: 'carga las configuraciones de otros agentes' },
  { patron: /^\.github\/CODEOWNERS$/, motivo: 'nombra a la cuenta de otro propietario' },
  { patron: /^scripts\/simular-conversacion\.mts$/, motivo: 'usa el agente genérico y la configuración de otro cliente' },
  { patron: /(^|\/)(\.git|node_modules|dist|coverage|\.security-reports|\.trivy-cache|\.claude)(\/|$)/, motivo: 'historia, dependencias, salidas o configuración personal' },
  { patron: /(^|\/)\.env($|\.(?!example$))/, motivo: 'variables de entorno locales' },
  { patron: /(^|\/)CONFIGURACION\.local\.md$|(^|\/)CONVERSACIONES\.json$|\.(pem|key|p12)$|(^|\/)credenciales[^/]*\.json$|-sa-key\.json$/, motivo: 'datos locales o secretos' },
];

const POR_DEFECTO_REFERENCIAS_PROHIBIDAS: ReadonlyArray<RegExp> = [
  /configuraciones\/corpus/,
  /configuraciones\/(segurolotengo|comercio-agendamiento)\.json/,
  /['"`/](segurolotengo|comercio-agendamiento)\.json/,
  /integraciones\/segurolotengo/,
  /herramientas-http/,
  /proveedor-bedrock|conocimiento-pgvector|canal-web/,
];

/** Identificadores de AAB1 y patrones de claves que no deben aparecer en el destino. */
const PROHIBIDOS_EN_DESTINO: ReadonlyArray<{ patron: RegExp; que: string }> = [
  { patron: /rag-generico/, que: 'proyecto de AAB1' },
  { patron: /segurolotengo-demo/, que: 'repositorio demo de AAB1' },
  { patron: /1045414922333|69578817451/, que: 'número de proyecto de AAB1' },
  { patron: /chatbotrag-[a-z0-9]+-[a-z]{2}\.a\.run\.app|chatbotrag-\d+\.[a-z0-9-]+\.run\.app/, que: 'URL de Cloud Run de AAB1' },
  { patron: /segurolotengopy/, que: 'cuenta de GitHub de AAB1' },
  { patron: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, que: 'clave privada' },
  { patron: /AIza(?![0-9A-Za-z_-]*EJEMPLO)[0-9A-Za-z_-]{35}/, que: 'clave de API de Google' },
  { patron: /AKIA(?![0-9A-Z]*EXAMPLE)[0-9A-Z]{16}/, que: 'clave de acceso de AWS' },
  { patron: /gh[pousr]_[0-9A-Za-z]{36,}/, que: 'token de GitHub' },
];

/**
 * Sustituciones puntuales sobre archivos copiados tal cual: valores por omisión que apuntan al origen y que no
 * justifican un overlay completo. Si el texto a sustituir no existe, la extracción falla (el origen cambió y la
 * sustitución quedó obsoleta: mejor ruido que un identificador del origen colado).
 */
const SUSTITUCIONES: ReadonlyArray<{ archivo: string; de: string; a: string }> = [
  { archivo: 'scripts/configurar-monitoreo.sh', de: 'segurolotengopy/ChatbotRAG', a: '<PROPIETARIO>/<REPOSITORIO>' },
];

/**
 * Recortes dentro de pruebas que se copian: casos que ejercitan lo recortado (otro agente en el mismo servicio, las rutas
 * generales, pgvector). Se quita el bloque exacto, de `desde` a la primera aparición de `hasta` (inclusive); si el texto
 * ya no está, la extracción falla en lugar de dejar la prueba a medias. No se debilita ninguna prueba de Kuaa.
 */
const RECORTES_DE_PRUEBA: ReadonlyArray<{ archivo: string; quitar: ReadonlyArray<{ desde: string; hasta: string }> }> = [
  {
    archivo: 'servicio/src/kuaa.prueba.ts',
    quitar: [
      { desde: "const CLAVE_TIENDA", hasta: '\n' },
      { desde: "  const tienda = {", hasta: '\n' },
      { desde: "    await writeFile(\n      join(dir, 'tienda.json'),", hasta: '\n    );\n' },
      { desde: "        { id: 'tienda-web'", hasta: '\n' },
      { desde: "  it('con un cliente cuyo agente no es Kuaa responde 404'", hasta: '\n  });\n' },
      { desde: "  it('las rutas generales responden 404 AGENTE_KUAA", hasta: '\n  });\n' },
    ],
  },
  {
    archivo: 'servicio/src/paquete-kuaa.prueba.ts',
    quitar: [{ desde: "  it('con pgvector y perfil pruebas no se lee el bucket", hasta: '\n  });\n' }],
  },
];

export function esIncluida(ruta: string): boolean {
  if (EXCLUSIONES.some((e) => e.patron.test(ruta))) return false;
  return INCLUIR_EXACTOS.has(ruta) || INCLUIR_PREFIJOS.some((p) => ruta.startsWith(p));
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Archivos del repositorio: los que git conoce (`git ls-files`) más los nuevos sin confirmar que no están ignorados, para
 * que el subset refleje el árbol de trabajo. `.git` nunca aparece en esa lista.
 */
function listarArchivos(): string[] {
  return git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((r) => r.length > 0)
    .filter((r) => {
      try {
        return lstatSync(join(RAIZ, r)).isFile();
      } catch {
        return false; // borrado en el árbol de trabajo
      }
    });
}

export function validarDestino(destino: string): string | null {
  const abs = resolve(destino);
  const rel = relative(RAIZ, abs);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return 'el destino está dentro del repositorio de origen';
  const relInverso = relative(abs, RAIZ);
  if (!relInverso.startsWith('..') && relInverso !== '') return 'el destino contiene al repositorio de origen';
  if (existsSync(abs)) {
    const st = lstatSync(abs);
    if (!st.isDirectory()) return 'el destino existe y no es un directorio';
    if (readdirSync(abs).length > 0) return 'el destino existe y no está vacío';
  }
  return null;
}

function archivosDelOverlay(): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const ruta = join(dir, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else if (e.isFile()) salida.push(relative(OVERLAY, ruta).split(sep).join('/'));
    }
  };
  if (existsSync(OVERLAY)) recorrer(OVERLAY);
  return salida.sort();
}

function copiar(origen: string, destinoAbs: string): void {
  mkdirSync(dirname(destinoAbs), { recursive: true });
  copyFileSync(origen, destinoAbs);
}

/** Archivos de texto del destino (sin dependencias ni salidas), para las búsquedas. */
function archivosDeTexto(raiz: string): string[] {
  const salida: string[] = [];
  const recorrer = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', '.git', 'dist', 'coverage'].includes(e.name)) continue;
      const ruta = join(dir, e.name);
      if (e.isDirectory()) recorrer(ruta);
      else if (e.isFile() && !/\.(docx|png|jpg|pdf|zip)$/i.test(e.name)) salida.push(ruta);
    }
  };
  recorrer(raiz);
  return salida;
}

/** Pasos 4: ninguna pieza copiada puede mencionar algo recortado (ni siquiera una prueba). Devuelve los hallazgos. */
export function referenciasARecortes(raiz: string): string[] {
  const hallazgos: string[] = [];
  for (const archivo of archivosDeTexto(raiz)) {
    const rel = relative(raiz, archivo).split(sep).join('/');
    if (!/\.(ts|mts|js|json|sh|ya?ml)$/.test(rel) || rel === 'pnpm-lock.yaml' || rel === 'ORIGEN.md') continue;
    const texto = readFileSync(archivo, 'utf8');
    for (const p of POR_DEFECTO_REFERENCIAS_PROHIBIDAS) if (p.test(texto)) hallazgos.push(`${rel}: menciona una pieza recortada (${p.source})`);
  }
  return hallazgos;
}

export function buscarProhibidos(raiz: string): string[] {
  const hallazgos: string[] = [];
  for (const archivo of archivosDeTexto(raiz)) {
    const texto = readFileSync(archivo, 'utf8');
    for (const { patron, que } of PROHIBIDOS_EN_DESTINO) if (patron.test(texto)) hallazgos.push(`${relative(raiz, archivo)}: ${que}`);
  }
  return hallazgos;
}

function ejecutar(destino: string, comando: string, args: string[]): void {
  console.log(`[verificar] ${comando} ${args.join(' ')}`);
  execFileSync(comando, args, { cwd: destino, stdio: 'inherit', env: { ...process.env, CI: '' } });
}

function extraer(destino: string, verificar: boolean, almacen: string | null): number {
  const abs = resolve(destino);
  const archivos = listarArchivos().filter(esIncluida).sort();
  for (const r of archivos) copiar(join(RAIZ, r), join(abs, r));
  const overlay = archivosDelOverlay();
  for (const r of overlay) copiar(join(OVERLAY, r), join(abs, r));

  for (const { archivo, de, a } of SUSTITUCIONES) {
    const ruta = join(abs, archivo);
    const texto = readFileSync(ruta, 'utf8');
    if (!texto.includes(de)) throw new Error(`La sustitución de ${archivo} quedó obsoleta: ya no contiene «${de}»`);
    writeFileSync(ruta, texto.split(de).join(a));
  }

  for (const { archivo, quitar } of RECORTES_DE_PRUEBA) {
    const ruta = join(abs, archivo);
    let texto = readFileSync(ruta, 'utf8');
    for (const { desde, hasta } of quitar) {
      const i = texto.indexOf(desde);
      const j = i < 0 ? -1 : texto.indexOf(hasta, i + desde.length);
      if (i < 0 || j < 0) throw new Error(`El recorte de ${archivo} quedó obsoleto: no se halla «${desde.trim().slice(0, 50)}»`);
      texto = texto.slice(0, i) + texto.slice(j + hasta.length);
    }
    writeFileSync(ruta, texto);
  }

  const commit = git(['rev-parse', 'HEAD']).trim();
  const sucio = git(['status', '--porcelain']).trim().length > 0;
  const excluidas = EXCLUSIONES.map((e) => `- ${e.patron.source}: ${e.motivo}`).join('\n');
  writeFileSync(
    join(abs, 'ORIGEN.md'),
    [
      '# Origen de este repositorio',
      '',
      `Extraído de ChatbotRAG (commit \`${commit}\`) el ${new Date().toISOString().slice(0, 10)} con \`scripts/extraer-subset-kuaa.mts\`.`,
      `Árbol de origen con cambios sin confirmar al extraer: ${sucio ? 'SÍ (la copia refleja el árbol de trabajo, no el commit)' : 'no'}.`,
      '',
      'Es una copia independiente y sin historial: desde aquí son dos bases de código distintas. Un arreglo del origen se',
      'porta a mano, con PR.',
      '',
      '## Qué se recortó (exclusiones explícitas)',
      excluidas,
      '',
      '## Qué se reemplazó (overlay solo-Kuaa)',
      ...overlay.map((r) => `- ${r}`),
      '',
      '## Pendiente de completar por el propietario',
      '- `.devsecops.yml`: reemplazar los marcadores `<...>`.',
      '- `docs/ARQUITECTURA.md` y `docs/COSTOS-GCP.md` no se copiaron (contienen identificadores del origen); se redactan para Kuaa.',
      '- `.github/CODEOWNERS`, `.claude/` y `CLAUDE.md` no se copiaron; los define el propietario.',
      '',
    ].join('\n'),
  );
  console.log(`Extraídos ${archivos.length} archivos y ${overlay.length} del overlay en ${abs}`);

  const referencias = referenciasARecortes(abs);
  if (referencias.length > 0) {
    console.error(`El subset menciona piezas recortadas:\n${referencias.join('\n')}`);
    return 1;
  }
  if (!verificar) return 0;

  const prohibidos = buscarProhibidos(abs);
  if (prohibidos.length > 0) {
    console.error(`Hallazgos de identificadores o claves en el destino:\n${prohibidos.join('\n')}`);
    return 1;
  }
  ejecutar(abs, 'pnpm', ['install', '--offline', ...(almacen ? ['--store-dir', almacen] : [])]);
  ejecutar(abs, 'pnpm', ['tipos']);
  ejecutar(abs, 'pnpm', ['pruebas']);
  console.log('[verificar] subset verificado: instalación, tipos, pruebas y búsqueda de identificadores correctos.');
  return 0;
}

function principal(): void {
  const args = process.argv.slice(2);
  const destino = args.find((a) => !a.startsWith('--'));
  const verificar = args.includes('--verificar');
  const simular = args.includes('--simular');
  const almacen = args.find((a) => a.startsWith('--almacen='))?.slice('--almacen='.length) ?? null;
  if (!destino) {
    console.error('Uso: extraer-subset-kuaa.mts <destino> [--verificar] [--simular] [--almacen=<dir>]');
    process.exit(2);
  }
  const problema = validarDestino(destino);
  if (problema) {
    console.error(`Destino rechazado: ${problema}`);
    process.exit(2);
  }
  if (simular) {
    for (const r of listarArchivos().filter(esIncluida).sort()) console.log(r);
    for (const r of archivosDelOverlay()) console.log(`overlay:${r}`);
    return;
  }
  try {
    process.exit(extraer(destino, verificar, almacen));
  } catch (e) {
    console.error(`Falló la extracción: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) principal();
