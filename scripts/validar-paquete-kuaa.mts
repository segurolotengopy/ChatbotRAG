/**
 * VALIDADOR DE PAQUETES DE CONOCIMIENTO PARA KUAA
 *
 * Uso: node --import tsx scripts/validar-paquete-kuaa.mts [--exigir-habilitados] archivo.json...
 * Cada archivo es un arreglo JSON de registros, un objeto con `registros` (arreglo) o un
 * objeto único (un solo registro); cualquier otra raíz falla. Imprime SOLO conteos por archivo
 * (habilitados y rechazados por motivo), jamás contenido. Con --exigir-habilitados sale
 * con código 1 si ningún archivo aporta registros habilitados. También sale con 1 si un
 * archivo no se puede leer o no es JSON.
 */
import { readFileSync } from 'node:fs';
import { separarRegistrosHabilitados } from '../paquetes/nucleo/src/indice.js';

const args = process.argv.slice(2);
const exigir = args.includes('--exigir-habilitados');
const rutas = args.filter((a) => a !== '--exigir-habilitados');
if (rutas.length === 0) {
  console.error('Uso: validar-paquete-kuaa.mts [--exigir-habilitados] archivo.json...');
  process.exit(2);
}

let totalHabilitados = 0;
let fallo = false;
for (const ruta of rutas) {
  try {
    const raiz: unknown = JSON.parse(readFileSync(ruta, 'utf8'));
    let forma: 'array' | 'registros' | 'objeto';
    let registros: unknown;
    if (Array.isArray(raiz)) {
      forma = 'array';
      registros = raiz;
    } else if (typeof raiz === 'object' && raiz !== null) {
      const interno = (raiz as Record<string, unknown>)['registros'];
      if (Array.isArray(interno)) {
        forma = 'registros';
        registros = interno;
      } else {
        forma = 'objeto';
        registros = [raiz];
      }
    } else {
      fallo = true;
      console.error(`${ruta}: no es un arreglo de registros`);
      continue;
    }
    const { conteo } = separarRegistrosHabilitados(registros);
    totalHabilitados += conteo.habilitados;
    const m = conteo.porMotivo;
    console.log(
      `${ruta}: forma=${forma} total=${conteo.total} habilitados=${conteo.habilitados} rechazados=${conteo.rechazados} ` +
        `(no_habilitado=${m.no_habilitado} valor_no_booleano=${m.valor_no_booleano} ` +
        `campo_ausente=${m.campo_ausente} registro_invalido=${m.registro_invalido})`,
    );
  } catch {
    fallo = true;
    console.error(`${ruta}: no se pudo leer como JSON`);
  }
}
if (fallo || (exigir && totalHabilitados === 0)) {
  if (exigir && totalHabilitados === 0) console.error('Ningún registro habilitado para producción.');
  process.exit(1);
}
