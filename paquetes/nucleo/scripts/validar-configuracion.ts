// Valida uno o más archivos JSON de configuración y comprueba que las fuentes del
// corpus existan en disco. Uso: pnpm validar-config configuraciones/*.json
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cargarConfiguracionDesdeJson, ErrorConfiguracion, resolverConfiguracion } from '../src/indice.js';
import { validarHerramientas } from '../src/herramientas/registro.js';

const archivos = process.argv.slice(2);
if (archivos.length === 0) {
  console.error('Uso: pnpm validar-config <archivo.json> [...]');
  process.exit(2);
}
let fallas = 0;
for (const archivo of archivos) {
  try {
    const config = cargarConfiguracionDesdeJson(readFileSync(archivo, 'utf8'));
    const problemas = validarHerramientas(config);
    const base = join(dirname(resolve(archivo)), 'corpus');
    for (const perfilId of [null, ...Object.keys(config.perfiles)]) {
      const efectiva = resolverConfiguracion(config, perfilId);
      for (const f of efectiva.conocimiento.fuentes) {
        if (!existsSync(join(base, f.ruta))) problemas.push(`${perfilId ?? 'base'}: no existe el archivo de la fuente «${f.id}»: corpus/${f.ruta}`);
      }
    }
    if (problemas.length) {
      fallas++;
      console.error(`✗ ${archivo}`);
      for (const p of problemas) console.error(`   - ${p}`);
    } else {
      console.log(`✓ ${archivo} (${Object.keys(config.perfiles).length} perfiles)`);
    }
  } catch (e) {
    fallas++;
    console.error(`✗ ${archivo}`);
    if (e instanceof ErrorConfiguracion) for (const d of e.detalles) console.error(`   - ${d}`);
    else console.error(`   - ${e instanceof Error ? e.message : String(e)}`);
  }
}
process.exit(fallas ? 1 : 0);
