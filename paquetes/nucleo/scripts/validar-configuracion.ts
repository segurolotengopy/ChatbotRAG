// Valida uno o más archivos JSON de configuración y comprueba que las fuentes del
// corpus existan en disco. Uso: pnpm validar-config configuraciones/*.json
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { cargarConfiguracionDesdeJson, ErrorConfiguracion, quitarComentariosHtml, resolverConfiguracion } from '../src/indice.js';
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
        const archivoFuente = join(base, f.ruta);
        if (!existsSync(archivoFuente)) {
          problemas.push(`${perfilId ?? 'base'}: no existe el archivo de la fuente «${f.id}»: corpus/${f.ruta}`);
          continue;
        }
        // Chequeo fuera de línea: si el primer renglón es `<!-- id | … -->`, ese id debe ser de una
        // página que apunte a esta fuente. Sin comentario no se exige nada.
        const apuntan = efectiva.conocimiento.paginas.filter((p) => p.fuenteId === f.id);
        if (apuntan.length === 0) continue;
        const contenido = readFileSync(archivoFuente, 'utf8');
        // Tras quitar los comentarios bien formados no debe quedar ninguna marca suelta.
        if (/<!--|-->/.test(quitarComentariosHtml(contenido))) {
          problemas.push(`${perfilId ?? 'base'}: la fuente «${f.id}» tiene un comentario HTML mal formado (<!-- o --> sin su par)`);
        }
        const marca = /^<!--\s*([a-z0-9][a-z0-9-]*)\s*\|/.exec(contenido.split(/\r?\n/, 1)[0] ?? '');
        if (marca && !apuntan.some((p) => p.id === marca[1])) {
          problemas.push(`${perfilId ?? 'base'}: la fuente «${f.id}» declara la página «${marca[1]}» pero ninguna página de la configuración con ese id apunta a ella`);
        }
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
