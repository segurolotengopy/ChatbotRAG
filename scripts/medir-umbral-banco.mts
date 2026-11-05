/**
 * MEDICIÓN DE UMBRALES DEL EMPAREJAMIENTO SEMÁNTICO DEL BANCO (modelo híbrido, H3)
 *
 * Uso: node --import tsx scripts/medir-umbral-banco.mts --banco=<ruta> --evaluacion=<ruta> --proveedor=simulado|vertex
 *        [--sha256=<sha256 esperado del banco>] [--sha256-evaluacion=<sha256 esperado de la evaluación>]
 *        [--margen=0.05] [--diferencia-derivacion=0]
 *
 * Por qué existe: el umbral no va en el código (D9): se mide aquí con el banco y el conjunto de evaluación reales,
 * que viven FUERA del repositorio, y el informe queda ligado a modelo, dimensión y SHA-256 del banco. El script
 * embebe una sola vez las preguntas del banco y los casos, barre los umbrales de 0,50 a 0,99 y aplica
 * `elegirUmbral` (el menor umbral sin confusiones ni falsos positivos «ninguna» en calibración; el control solo
 * valida).
 *
 * Seguridad: `--banco` y `--evaluacion` deben estar FUERA de cualquier copia del repositorio (el worktree y la
 * raíz real que resuelve `git --git-common-dir`), comparando rutas reales; si no, sale con código 1 sin leer nada.
 * Imprime SOLO conteos, umbrales, margen, modelo, dimensión y los SHA-256 del banco y de la evaluación; jamás el
 * texto de un caso ni del banco, y los errores no repiten valores. Un banco sintético solo se admite con
 * `--proveedor=simulado`. `--proveedor=vertex` usa `@chatbotrag/proveedor-vertex` (ADC; `GCP_PROYECTO` y
 * `GCP_REGION` en el entorno) y exige `--sha256` y `--sha256-evaluacion`; cada ejecución con Vertex llama al servicio de embeddings, con costo.
 *
 * Lectura: cada archivo se lee por su ruta REAL ya comprobada, debe ser un archivo regular de hasta 20 MiB (si no,
 * «archivo no admitido»), y los textos de la evaluación con forma de secreto se rechazan. Los errores imprimen solo
 * el mensaje de los errores propios (banco, evaluación, similitud); de cualquier otro, solo su nombre y su código de
 * sistema con un texto fijo, nunca su mensaje (podría llevar rutas o contenido).
 *
 * Códigos de salida: 0 calibración válida; 1 ruta dentro del repo, error de lectura/validación, sin umbral factible,
 * calibración con los mínimos de D8 sin cumplir (`minimos_calibracion_insuficientes`) o calibración inválida
 * (confusión o falso positivo «ninguna» en el control, o mínimos de D8 del control sin cumplir); 2 uso incorrecto.
 * Si el umbral elegido es el piso del barrido (0,50) (o la derivación queda por debajo de él) el informe agrega `umbral_en_piso=true`: es sospechoso, porque
 * suele indicar que ningún error obligó a subirlo.
 *
 * Qué NO garantiza: que el resultado generalice al tráfico real, ni que el proveedor simulado (hashing de palabras,
 * sin semántica) sirva para fijar un umbral de producción. No conecta nada al agente (H4) ni enciende `carrilFijo`.
 */
import { execFileSync } from 'node:child_process';
import { closeSync, constants, existsSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EmbebedorSimulado,
  ErrorBanco,
  ErrorEvaluacion,
  ErrorSimilitud,
  UMBRAL_MINIMO_BARRIDO,
  barrerUmbrales,
  cargarBanco,
  cargarEvaluacion,
  elegirUmbral,
  prepararIndiceSemantico,
  verificarMinimos,
} from '../paquetes/nucleo/src/indice.js';
import type { CasoMedible, Conteos, Embebedor } from '../paquetes/nucleo/src/indice.js';

const RAIZ_REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function dentroDe(carpeta: string, ruta: string): boolean {
  const r = relative(resolve(carpeta), resolve(ruta));
  return !(r === '..' || r.startsWith(`..${sep}`) || isAbsolute(r));
}

/** `realpath` del ancestro existente más profundo, más el resto sin resolver. */
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

function raicesProhibidas(): string[] {
  const raices = [rutaReal(RAIZ_REPO)];
  try {
    const comun = execFileSync('git', ['-C', RAIZ_REPO, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
    raices.push(rutaReal(dirname(comun)));
  } catch {
    // Sin git queda la raíz del propio árbol.
  }
  return raices;
}

function valor(args: string[], nombre: string): string | undefined {
  const prefijo = `--${nombre}=`;
  return args.find((a) => a.startsWith(prefijo))?.slice(prefijo.length);
}

function salir(codigo: number, mensaje: string): never {
  console.error(mensaje);
  process.exit(codigo);
}

const MAX_BYTES = 20 * 1024 * 1024;

/**
 * Lee un archivo regular de hasta 20 MiB desde un descriptor ya abierto: el tipo y el tamaño se miran con
 * `fstatSync(fd)` sobre el mismo descriptor que se lee (sin carrera entre comprobar y leer), y la lectura se detiene
 * si el archivo crece más allá de lo medido. Cualquier otra cosa sale con código 1. El descriptor se cierra siempre.
 */
function leerAcotado(real: string): string {
  const fd = openSync(real, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) salir(1, 'archivo no admitido');
    const buffer = Buffer.alloc(st.size + 1);
    let leidos = 0;
    while (leidos < buffer.length) {
      const n = readSync(fd, buffer, leidos, buffer.length - leidos, null);
      if (n === 0) break;
      leidos += n;
    }
    if (leidos > st.size) salir(1, 'archivo no admitido');
    return buffer.toString('utf8', 0, leidos);
  } finally {
    closeSync(fd);
  }
}

const f = (n: number): string => String(Math.round(n * 1e4) / 1e4);
const linea = (nombre: string, c: Conteos): string =>
  `${nombre} total=${c.total} aciertos=${c.aciertos} confusiones=${c.confusiones} falsos_positivos=${c.falsosPositivos} falsos_negativos=${c.falsosNegativos} cobertura=${f(c.cobertura)}`;

async function crearEmbebedor(proveedor: string): Promise<Embebedor> {
  if (proveedor === 'simulado') return new EmbebedorSimulado();
  const proyecto = process.env['GCP_PROYECTO'];
  const region = process.env['GCP_REGION'];
  if (!proyecto || !region) salir(2, 'Con --proveedor=vertex hacen falta GCP_PROYECTO y GCP_REGION en el entorno.');
  const vertex = await import('../paquetes/proveedor-vertex/src/indice.js');
  return new vertex.EmbebedorVertex(vertex.crearClienteVertex({ proyecto, region }));
}

async function principal(): Promise<void> {
  const args = process.argv.slice(2);
  const rutaBanco = valor(args, 'banco');
  const rutaEvaluacion = valor(args, 'evaluacion');
  const proveedor = valor(args, 'proveedor');
  const sha256 = valor(args, 'sha256');
  const sha256Evaluacion = valor(args, 'sha256-evaluacion');
  const textoMargen = valor(args, 'margen');
  const textoDiferencia = valor(args, 'diferencia-derivacion');
  // Number('') vale 0: un valor vacío se rechazaría mal si no se mira antes.
  if (textoMargen?.trim() === '' || textoDiferencia?.trim() === '') salir(2, '--margen y --diferencia-derivacion no pueden estar vacíos.');
  const margen = Number(textoMargen ?? '0.05');
  const diferencia = Number(textoDiferencia ?? '0');
  if (!rutaBanco || !rutaEvaluacion || (proveedor !== 'simulado' && proveedor !== 'vertex')) {
    salir(2, 'Uso: medir-umbral-banco.mts --banco=<ruta> --evaluacion=<ruta> --proveedor=simulado|vertex [--sha256=...] [--sha256-evaluacion=...] [--margen=0.05] [--diferencia-derivacion=0]');
  }
  if (!Number.isFinite(margen) || margen < 0 || margen > 1 || !Number.isFinite(diferencia) || diferencia < 0 || diferencia > 0.5) {
    salir(2, '--margen debe estar en [0, 1] y --diferencia-derivacion en [0, 0.5].');
  }
  if (proveedor === 'vertex' && (!sha256 || !sha256Evaluacion)) salir(2, 'Con --proveedor=vertex se exigen --sha256 y --sha256-evaluacion.');

  try {
    const prohibidas = raicesProhibidas();
    const reales = [rutaBanco, rutaEvaluacion].map((ruta) => {
      const real = rutaReal(ruta);
      if (prohibidas.some((r) => dentroDe(r, real) || dentroDe(r, resolve(ruta)))) {
        salir(1, 'El banco y la evaluación deben estar fuera del repositorio.');
      }
      return real;
    });
    const [realBanco, realEvaluacion] = reales as [string, string];

    const { banco, sha256: shaBanco } = cargarBanco(leerAcotado(realBanco), {
      ...(sha256 === undefined ? {} : { sha256Esperado: sha256 }),
      admitirSintetico: proveedor === 'simulado',
    });
    const { evaluacion, sha256: shaEvaluacion } = cargarEvaluacion(leerAcotado(realEvaluacion), banco, {
      ...(sha256Evaluacion === undefined ? {} : { sha256Esperado: sha256Evaluacion }),
    });

    const embebedor = await crearEmbebedor(proveedor);
    const indice = await prepararIndiceSemantico(banco, embebedor);
    const vectores = await embebedor.embeber(evaluacion.casos.map((c) => c.texto));
    if (vectores.length !== evaluacion.casos.length) throw new Error('cantidad de vectores distinta de la de casos');
    const casos: CasoMedible[] = evaluacion.casos.map((c, i) => ({ id: c.id, vector: vectores[i] as number[], esperado: c.esperado, particion: c.particion }));

    const minimos = verificarMinimos(casos, indice);
    const elegido = elegirUmbral(barrerUmbrales(casos, indice, { margen, diferenciaDerivacion: diferencia }), minimos);

    console.log(`banco_sha256=${shaBanco}`);
    console.log(`evaluacion_sha256=${shaEvaluacion}`);
    console.log(`modelo=${indice.modelo} dimension=${indice.dimension}`);
    console.log(
      `minimos calibracion_minimo_por_entrada=${minimos.calibracion.minimoPorEntrada} calibracion_casos_ninguna=${minimos.calibracion.casosNinguna} ` +
        `control_minimo_por_entrada=${minimos.control.minimoPorEntrada} control_casos_ninguna=${minimos.control.casosNinguna} cumple=${minimos.cumple}`,
    );
    if (elegido === null) {
      console.log(`margen=${f(margen)}`);
      console.log(`resultado=${minimos.calibracion.cumple ? 'sin_umbral_factible' : 'minimos_calibracion_insuficientes'}`);
      process.exit(1);
    }
    console.log(`umbral_fijo=${f(elegido.umbralFijo)} umbral_derivacion=${f(elegido.umbralDerivacion)} margen=${f(elegido.margen)}`);
    if (elegido.umbralFijo === UMBRAL_MINIMO_BARRIDO || elegido.umbralDerivacion < UMBRAL_MINIMO_BARRIDO) console.log('umbral_en_piso=true');
    console.log(linea('calibracion', elegido.calibracion));
    console.log(linea('control', elegido.control));
    console.log(`resultado=${elegido.valido ? 'valido' : `invalido motivos=${elegido.motivosInvalidez.join(',')}`}`);
    if (!elegido.valido) process.exit(1);
  } catch (e) {
    // Solo los errores propios muestran su mensaje (no llevan valores). Del resto, nombre y código con texto fijo.
    if (e instanceof ErrorBanco || e instanceof ErrorEvaluacion) {
      salir(1, `${e.name}: ${e.message}${e.detalles.length > 0 ? ` (${e.detalles.join('; ')})` : ''}`);
    }
    if (e instanceof ErrorSimilitud) salir(1, `${e.name}: ${e.message}`);
    const codigo = e instanceof Error && 'code' in e && typeof e.code === 'string' ? ` código=${e.code}` : '';
    salir(1, `Error no detallado: ${e instanceof Error ? e.name : 'desconocido'}${codigo}`);
  }
}

await principal();
