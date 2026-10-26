/**
 * PREPARACIÓN DEL PAQUETE DE CONOCIMIENTO DE KUAA PARA STAGING
 *
 * Uso: node --import tsx scripts/preparar-paquete-kuaa.mts <carpeta-origen> <carpeta-salida> <version X.Y.Z>
 *
 * Porqué: el paquete que entrega el equipo de contenido no trae las marcas que el perfil `pruebas` del
 * servicio exige, ni sirve tal cual (hay .docx, PDF, CSV duplicados, prompts, evaluaciones). Este script lo
 * convierte en la carpeta que se sube al bucket privado: JSON estampados con `habilitado_produccion:false`,
 * `validacion:"no_validado"` y `version_paquete`, los .docx convertidos a .md, y un `manifiesto.json` con el
 * SHA-256 de cada archivo (lo verifica el lector del servicio).
 *
 * Qué entra y qué no lo decide una LISTA LITERAL (`LISTA_PAQUETE_REAL`), no un patrón: lo que no está en la
 * lista no entra. Quedan fuera a propósito los PDF, el brochure, los `PROMPT_*.txt` (son instrucciones, no
 * datos: cargarlos al RAG sería una inyección), los formularios, las imágenes, los CSV y JSONL (duplican los
 * JSON) y las `PRUEBAS_*` (se reservan como conjunto de evaluación).
 *
 * Seguridad: la carpeta de origen es de solo lectura. Solo escribe en la carpeta de salida, que debe ser nueva
 * (o vacía), y se niega si cae dentro de CUALQUIER copia del repositorio (el worktree y la raíz real que
 * resuelve `git --git-common-dir`), dentro del origen o bajo `~/Documentos` (con cualquier capitalización).
 * Compara rutas REALES (`realpath` del ancestro existente) y rechaza symlinks en la salida y en los archivos de
 * origen. Verifica el SHA-256 de cada archivo usado contra el manifiesto de origen. Las imágenes incrustadas
 * (`data:`) se eliminan del Markdown. Ningún archivo de salida pasa de 5 MB ni el paquete de 50 MB (los topes
 * del lector). Imprime solo conteos y avisos, jamás contenido.
 *
 * REVISIÓN HUMANA: `CONVERSACIONES.json` puede traer datos personales de personas reales; el script imprime un
 * aviso y nadie debe subir el paquete sin que una persona lo revise. `MANUAL_CAPACITACION_IA.docx` NO entra:
 * contiene instrucciones dirigidas a una IA (la misma razón que los `PROMPT_*.txt`).
 *
 * Qué NO garantiza: que el contenido sea correcto, esté autorizado más allá de las pruebas ni libre de datos
 * de terceros; no anonimiza nada. La titularidad (`interseguros` o `alianza`) sale de la lista, no del archivo.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export type Titular = 'interseguros' | 'alianza';
export interface EntradaLista {
  /** Ruta relativa dentro de la carpeta de origen, tal como figura en su manifiesto. */
  ruta: string;
  titular: Titular;
  /** Con true, el script avisa que una persona debe revisar el archivo (datos personales) antes de subirlo. */
  revisionHumana?: boolean;
}

const TOPE_ARCHIVO = 5 * 1024 * 1024;
const TOPE_PAQUETE = 50 * 1024 * 1024;

const P1 = '01_MANUAL_INFORMATIVO_Y_BASE/';
const P2 = '02_MANUAL_COMERCIAL_Y_ETAPAS/';
const P3 = '03_DOCUMENTOS_PRODUCTO_REFERENCIA/';

/** Lista literal de lo que entra al paquete de pruebas (DP5). Todo lo demás se excluye. */
export const LISTA_PAQUETE_REAL: EntradaLista[] = [
  { ruta: `${P1}CONTRADICCIONES_Y_PENDIENTES.json`, titular: 'interseguros' },
  { ruta: `${P1}CONVERSACIONES.json`, titular: 'interseguros', revisionHumana: true },
  { ruta: `${P1}FICHA_VIVE.json`, titular: 'interseguros' },
  { ruta: `${P1}FUENTES.json`, titular: 'interseguros' },
  { ruta: `${P1}GLOSARIO.json`, titular: 'interseguros' },
  { ruta: `${P1}PREGUNTAS_RESPUESTAS.json`, titular: 'interseguros' },
  { ruta: `${P2}ARGUMENTOS_VENTA.json`, titular: 'interseguros' },
  { ruta: `${P2}ESPECIFICACION_SISTEMA_VENTAS.json`, titular: 'interseguros' },
  { ruta: `${P2}ETAPAS_VENTAS.json`, titular: 'interseguros' },
  { ruta: `${P2}OBJECIONES_VENTA.json`, titular: 'interseguros' },
  { ruta: `${P2}MANUAL_VENTAS_KUAA.docx`, titular: 'interseguros' },
  // Condicionado: titular Alianza; su permiso cubre solo las pruebas.
  { ruta: `${P3}CONDICIONADO_WORD_FUENTE.docx`, titular: 'alianza' },
];

export interface OpcionesPreparacion {
  origen: string;
  salida: string;
  version: string;
  lista?: EntradaLista[];
  /** Conversor de .docx a Markdown; por omisión, `mammoth`. Inyectable para las pruebas. */
  convertirDocx?: (archivo: string) => Promise<string>;
}

export interface ResumenPreparacion {
  archivos: number;
  registros: number;
  /** Archivos que una persona debe revisar antes de subir el paquete. */
  revisionHumana: string[];
}

const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const RAIZ_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Con `/` o `\\` como separador: la ruta relativa no sube ni sale de la raíz. */
function dentroDe(carpeta: string, ruta: string): boolean {
  const r = relative(resolve(carpeta), resolve(ruta));
  return !(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r));
}

/** `realpath` del ancestro existente más profundo, más el resto sin resolver (la ruta puede no existir aún). */
function rutaReal(ruta: string): string {
  let actual = resolve(ruta);
  const resto: string[] = [];
  while (!existsSync(actual)) {
    resto.unshift(basename(actual));
    const padre = dirname(actual);
    if (padre === actual) break;
    actual = padre;
  }
  return join(realpathSync(actual), ...resto);
}

function esSymlink(ruta: string): boolean {
  try {
    return lstatSync(ruta).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Raíces donde la salida está prohibida: este árbol, la raíz real del repositorio y `~/Documentos`. */
function raicesProhibidas(): string[] {
  const raices = [rutaReal(RAIZ_REPO)];
  try {
    const comun = execFileSync('git', ['-C', RAIZ_REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    raices.push(rutaReal(dirname(comun)));
  } catch {
    // Sin git no hay raíz común que añadir; queda la del propio árbol.
  }
  return raices;
}

function bajoDocumentos(salidaReal: string): boolean {
  const casa = realpathSync(homedir());
  const prefijo = `${casa}${sep}documentos`.toLowerCase();
  const s = salidaReal.toLowerCase();
  if (s === prefijo || s.startsWith(`${prefijo}${sep}`)) return true;
  // Carpetas reales de la casa que se llamen «documentos» en cualquier capitalización.
  return readdirSync(casa).some((n) => n.toLowerCase() === 'documentos' && dentroDe(rutaReal(join(casa, n)), salidaReal));
}

/** Quita las imágenes incrustadas (`data:`): no son texto y pueden esconder carga útil o datos personales. */
export function quitarImagenesIncrustadas(markdown: string): string {
  let actual = markdown;
  for (;;) {
    const siguiente = actual.replace(/!\[[^\]]*\]\(data:[^)]*\)/gi, '');
    if (siguiente === actual) return actual;
    actual = siguiente;
  }
}

async function convertirConMammoth(archivo: string): Promise<string> {
  // `convertToMarkdown` existe en tiempo de ejecución pero falta en los tipos publicados de mammoth.
  const mammoth = (await import('mammoth')).default as unknown as { convertToMarkdown(entrada: { path: string }): Promise<{ value: string }> };
  const r = await mammoth.convertToMarkdown({ path: archivo });
  return r.value;
}

function estampar(registro: unknown, version: string): unknown {
  if (typeof registro !== 'object' || registro === null || Array.isArray(registro)) return registro;
  // Se fuerza `false` aunque el origen traiga otro valor: este paquete es no validado por definición.
  return { ...(registro as Record<string, unknown>), habilitado_produccion: false, validacion: 'no_validado', version_paquete: version };
}

/** Devuelve la raíz estampada y cuántos registros tocó. Cualquier raíz que no sea arreglo u objeto falla. */
function estamparRaiz(raiz: unknown, version: string): { raiz: unknown; registros: number } {
  if (Array.isArray(raiz)) return { raiz: raiz.map((r) => estampar(r, version)), registros: raiz.length };
  if (typeof raiz === 'object' && raiz !== null) {
    const interno = (raiz as Record<string, unknown>)['registros'];
    if (Array.isArray(interno)) return { raiz: { ...(raiz as Record<string, unknown>), registros: interno.map((r) => estampar(r, version)) }, registros: interno.length };
    return { raiz: estampar(raiz, version), registros: 1 };
  }
  throw new Error('la raíz de un JSON no es un arreglo ni un objeto');
}

export async function prepararPaquete(opciones: OpcionesPreparacion): Promise<ResumenPreparacion> {
  const { version } = opciones;
  const lista = opciones.lista ?? LISTA_PAQUETE_REAL;
  const convertir = opciones.convertirDocx ?? convertirConMammoth;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) throw new Error('la versión debe tener la forma X.Y.Z');
  if (esSymlink(resolve(opciones.salida))) throw new Error('la carpeta de salida no puede ser un enlace simbólico');
  const origen = rutaReal(opciones.origen);
  const salida = rutaReal(opciones.salida);
  if (raicesProhibidas().some((r) => dentroDe(r, salida))) throw new Error('la carpeta de salida no puede estar dentro del repositorio');
  if (dentroDe(origen, salida)) throw new Error('la carpeta de salida no puede estar dentro del origen');
  if (bajoDocumentos(salida)) throw new Error('la carpeta de salida no puede estar bajo ~/Documentos');
  if (existsSync(salida) && readdirSync(salida).length > 0) throw new Error('la carpeta de salida debe estar vacía o no existir');

  const rutaManifiesto = join(origen, 'MANIFIESTO.json');
  if (esSymlink(rutaManifiesto)) throw new Error('el manifiesto de origen es un enlace simbólico');
  const crudoManifiesto = readFileSync(rutaManifiesto);
  const manifiestoOrigen = JSON.parse(crudoManifiesto.toString('utf8')) as { archivos?: Array<{ archivo: string; sha256: string }> };
  if (!Array.isArray(manifiestoOrigen.archivos)) throw new Error('el manifiesto de origen no trae `archivos`');
  const huellas = new Map(manifiestoOrigen.archivos.map((a) => [a.archivo, a.sha256]));

  const nombres = new Set<string>();
  const salidas: Array<{ nombre: string; contenido: string; titular: Titular }> = [];
  let registros = 0;
  for (const entrada of lista) {
    const esperada = huellas.get(entrada.ruta);
    if (esperada === undefined) throw new Error(`falta en el manifiesto de origen: ${entrada.ruta}`);
    const archivo = join(origen, entrada.ruta);
    if (!dentroDe(origen, archivo)) throw new Error('ruta fuera del origen');
    if (esSymlink(archivo)) throw new Error(`enlace simbólico en el origen: ${entrada.ruta}`);
    if (statSync(archivo).size > TOPE_ARCHIVO) throw new Error(`el archivo supera ${TOPE_ARCHIVO} bytes: ${entrada.ruta}`);
    const bytes = readFileSync(archivo);
    if (sha256(bytes) !== esperada) throw new Error(`el SHA-256 no coincide con el manifiesto: ${entrada.ruta}`);
    const esDocx = entrada.ruta.endsWith('.docx');
    const nombre = basename(entrada.ruta).replace(/\.docx$/, '.md');
    if (nombres.has(nombre)) throw new Error(`nombre de salida repetido: ${nombre}`);
    nombres.add(nombre);
    if (esDocx) {
      const md = quitarImagenesIncrustadas(await convertir(archivo)).trim();
      if (md === '') throw new Error(`la conversión quedó vacía: ${entrada.ruta}`);
      salidas.push({ nombre, contenido: `${md}\n`, titular: entrada.titular });
      registros += 1;
    } else {
      const r = estamparRaiz(JSON.parse(bytes.toString('utf8')), version);
      registros += r.registros;
      salidas.push({ nombre, contenido: `${JSON.stringify(r.raiz, null, 2)}\n`, titular: entrada.titular });
    }
  }

  const total = salidas.reduce((t, x) => t + Buffer.byteLength(x.contenido), 0);
  if (salidas.some((x) => Buffer.byteLength(x.contenido) > TOPE_ARCHIVO) || total > TOPE_PAQUETE) throw new Error('la salida supera los topes de tamaño del lector (5 MB por archivo, 50 MB en total)');

  mkdirSync(salida, { recursive: true });
  const archivos = salidas.map((s) => {
    writeFileSync(join(salida, s.nombre), s.contenido, 'utf8');
    return { ruta: s.nombre, sha256: sha256(s.contenido), bytes: Buffer.byteLength(s.contenido), titular: s.titular };
  });
  const manifiesto = { version, fecha: new Date().toISOString().slice(0, 10), origen_sha256: sha256(crudoManifiesto), archivos };
  writeFileSync(join(salida, 'manifiesto.json'), `${JSON.stringify(manifiesto, null, 2)}\n`, 'utf8');
  return { archivos: archivos.length, registros, revisionHumana: lista.filter((e) => e.revisionHumana).map((e) => e.ruta) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [origen, salida, version] = process.argv.slice(2);
  if (!origen || !salida || !version) {
    console.error('Uso: preparar-paquete-kuaa.mts <carpeta-origen> <carpeta-salida> <version X.Y.Z>');
    process.exit(2);
  }
  prepararPaquete({ origen, salida, version }).then(
    (r) => {
      console.log(`paquete preparado: archivos=${r.archivos} registros=${r.registros} version=${version}`);
      for (const ruta of r.revisionHumana) console.log(`AVISO: ${ruta} requiere revisión humana por datos personales antes de subir`);
    },
    (e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
