/**
 * VALIDADOR DE PAQUETES DE CONOCIMIENTO PARA KUAA
 *
 * Uso: node --import tsx scripts/validar-paquete-kuaa.mts [--perfil=produccion|pruebas] [--exigir-habilitados] archivo.json...
 * Cada archivo es un arreglo JSON de registros, un objeto con `registros` (arreglo) o un
 * objeto único (un solo registro); cualquier otra raíz falla. Imprime SOLO conteos por archivo
 * (habilitados, no validados y rechazados por motivo), jamás contenido. `--perfil=produccion` (por
 * omisión) acepta solo `habilitado_produccion === true`; `--perfil=pruebas` acepta además los `false` marcados
 * `validacion: "no_validado"` con `version_paquete` X.Y.Z, y los cuenta aparte (no_validado=N). Con --exigir-habilitados sale
 * con código 1 si ningún archivo aporta registros habilitados. También sale con 1 si un
 * archivo no se puede leer o no es JSON.
 */
import { readFileSync } from 'node:fs';
import { separarRegistrosHabilitados } from '../paquetes/nucleo/src/indice.js';

const args = process.argv.slice(2);
const exigir = args.includes('--exigir-habilitados');
const banderaPerfil = args.find((a) => a.startsWith('--perfil='));
const perfil = banderaPerfil === undefined ? 'produccion' : banderaPerfil.slice('--perfil='.length);
if (perfil !== 'produccion' && perfil !== 'pruebas') {
  console.error('--perfil debe ser produccion o pruebas');
  process.exit(2);
}
const rutas = args.filter((a) => a !== '--exigir-habilitados' && !a.startsWith('--perfil='));
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
    const { conteo } = separarRegistrosHabilitados(registros, perfil);
    totalHabilitados += conteo.habilitados;
    const m = conteo.porMotivo;
    console.log(
      `${ruta}: perfil=${perfil} forma=${forma} total=${conteo.total} habilitados=${conteo.habilitados} no_validado=${conteo.porEstado.no_validado} rechazados=${conteo.rechazados} ` +
        `(no_habilitado=${m.no_habilitado} valor_no_booleano=${m.valor_no_booleano} ` +
        `campo_ausente=${m.campo_ausente} registro_invalido=${m.registro_invalido} ` +
        `sin_marca_no_validado=${m.sin_marca_no_validado} version_invalida=${m.version_invalida})`,
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
