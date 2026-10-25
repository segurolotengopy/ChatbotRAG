/**
 * CARGA Y VALIDACIÓN DE LA CONFIGURACIÓN
 *
 * Además de validar contra el esquema Zod, esta función aplica dos controles que
 * el esquema no puede expresar:
 *
 * 1. NADA CON ASPECTO DE SECRETO. Un JSON de configuración se versiona, se copia
 *    al panel y viaja por correo. Si alguien pega una API key «para probar», el
 *    validador la rechaza por forma, no por nombre: claves largas de alta
 *    entropía, prefijos conocidos (`AIza`, `sk-`, `AKIA`, `ghp_`) y campos cuyo
 *    nombre sugiere credencial.
 *
 * 2. FACETAS DE ORIENTACIÓN SIN DATOS SENSIBLES. La orientación existe para
 *    preguntar cosas como «¿para quién es el seguro?», nunca «¿tiene alguna
 *    enfermedad?». Un id o una pregunta con vocabulario de salud, PEP, cédula o
 *    tarjeta se rechaza al cargar, no se filtra en tiempo de ejecución.
 */
import { esquemaConfiguracionAgente, type ConfiguracionAgente } from './esquema.js';
import { VOCABULARIO_SENSIBLE } from '../compuertas/vocabulario.js';
import { resolverConfiguracion } from './perfiles.js';

export class ErrorConfiguracion extends Error {
  constructor(
    mensaje: string,
    public readonly detalles: string[] = [],
  ) {
    super(mensaje);
    this.name = 'ErrorConfiguracion';
  }
}

const PREFIJOS_SECRETO = /(^|[^A-Za-z0-9])(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;
const NOMBRE_SECRETO = /(secret|token|apikey|api_key|clave_privada|password|contrasena|contraseña|credencial)/i;

function pareceSecreto(valor: string): boolean {
  if (PREFIJOS_SECRETO.test(valor)) return true;
  // Cadena larga sin espacios con mezcla de clases: alta entropía aparente.
  if (valor.length >= 32 && !/\s/.test(valor) && /[a-z]/.test(valor) && /[A-Z]/.test(valor) && /[0-9]/.test(valor)) {
    const unicos = new Set(valor).size;
    if (unicos / valor.length > 0.5) return true;
  }
  return false;
}

function recorrer(valor: unknown, ruta: string, hallazgos: string[]): void {
  if (typeof valor === 'string') {
    if (pareceSecreto(valor)) hallazgos.push(`${ruta}: el valor parece un secreto; los secretos no van en la configuración`);
    return;
  }
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => recorrer(v, `${ruta}[${i}]`, hallazgos));
    return;
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) {
      if (NOMBRE_SECRETO.test(k) && typeof v === 'string' && v.length > 0) {
        hallazgos.push(`${ruta}.${k}: nombre de campo con aspecto de credencial`);
      }
      recorrer(v, `${ruta}.${k}`, hallazgos);
    }
  }
}

function facetasSensibles(config: ConfiguracionAgente): string[] {
  const hallazgos: string[] = [];
  const revisar = (facetas: { id: string; pregunta: string; opciones: string[] }[] | undefined, ruta: string) => {
    for (const f of facetas ?? []) {
      const texto = `${f.id} ${f.pregunta} ${f.opciones.join(' ')}`;
      for (const [categoria, patron] of Object.entries(VOCABULARIO_SENSIBLE)) {
        if (patron.test(texto)) hallazgos.push(`${ruta}.${f.id}: la faceta toca la categoría «${categoria}»; la orientación no pide datos sensibles`);
      }
    }
  };
  revisar(config.orientacion.facetas, 'orientacion.facetas');
  for (const [id, perfil] of Object.entries(config.perfiles)) revisar(perfil.orientacion?.facetas, `perfiles.${id}.orientacion.facetas`);
  return hallazgos;
}

/**
 * PÁGINAS CONSISTENTES. Una pantalla apunta a una fuente que se indexa de verdad: si la fuente
 * no existe, es interna o el modo no es RAG, el manual nunca llegaría al prompt y el sitio
 * creería tener contexto de página que no tiene. Se rechaza al cargar, no en ejecución.
 * Se revisa la base y cada perfil con su configuración efectiva (la fusión reemplaza arreglos):
 * un perfil que redefine `fuentes` pero hereda `paginas` se rechaza si las fuentes ya no están.
 * `resolverConfiguracion(config, null)` resuelve al perfil por omisión si existe, no a la base
 * pura: por eso la etiqueta lo dice. También exige que el tope de caracteres admita al menos un
 * fragmento (tamaño + 200 de margen de solapamiento), o el manual nunca se inyectaría.
 */
export function paginasInvalidas(config: ConfiguracionAgente): string[] {
  const hallazgos: string[] = [];
  for (const perfilId of [null, ...Object.keys(config.perfiles)]) {
    const efectiva = resolverConfiguracion(config, perfilId);
    const { paginas, fuentes, modo, tamanoFragmento, maxCaracteresPagina } = efectiva.conocimiento;
    if (paginas.length === 0) continue;
    const donde = perfilId ?? (efectiva.perfilId ? `perfil por omisión ${efectiva.perfilId}` : 'base');
    if (modo !== 'rag') hallazgos.push(`conocimiento.paginas: requiere modo rag en ${donde}`);
    if (maxCaracteresPagina < tamanoFragmento + 200) {
      hallazgos.push(`conocimiento.maxCaracteresPagina: ${maxCaracteresPagina} es menor que tamanoFragmento + 200 (${tamanoFragmento + 200}) en ${donde}; ningún fragmento del manual cabría`);
    }
    const vistos = new Set<string>();
    for (const p of paginas) {
      if (vistos.has(p.id)) hallazgos.push(`conocimiento.paginas: id «${p.id}» repetido en ${donde}`);
      vistos.add(p.id);
      const fuente = fuentes.find((f) => f.id === p.fuenteId);
      if (!fuente) hallazgos.push(`conocimiento.paginas.${p.id}: la fuente «${p.fuenteId}» no existe en las fuentes de ${donde}`);
      else if (fuente.visibilidad !== 'publico') hallazgos.push(`conocimiento.paginas.${p.id}: la fuente «${p.fuenteId}» es interna y no se indexa en ${donde}`);
    }
  }
  // Un perfil que hereda las páginas de la base repetiría los mismos mensajes.
  return [...new Set(hallazgos)];
}

/**
 * `recomienda_plan` y `recomendar_opcion` se contradicen: la herramienta existe para recomendar y la
 * compuerta reemplaza toda respuesta que recomiende. Se rechaza al cargar, base y cada perfil con su
 * configuración efectiva (la fusión reemplaza arreglos), no en ejecución.
 */
export function recomiendaPlanConHerramienta(config: ConfiguracionAgente): string[] {
  const hallazgos: string[] = [];
  for (const perfilId of [null, ...Object.keys(config.perfiles)]) {
    const efectiva = resolverConfiguracion(config, perfilId);
    if (efectiva.seguridad.compuertasSalida.includes('recomienda_plan') && efectiva.herramientas.some((h) => h.nombre === 'recomendar_opcion')) {
      hallazgos.push(`seguridad.compuertasSalida: La compuerta recomienda_plan no puede convivir con la herramienta recomendar_opcion (${perfilId ?? 'base'})`);
    }
  }
  return [...new Set(hallazgos)];
}

/** Valida un objeto ya parseado. Lanza `ErrorConfiguracion` con todos los detalles. */
export function validarConfiguracion(entrada: unknown): ConfiguracionAgente {
  const resultado = esquemaConfiguracionAgente.safeParse(entrada);
  if (!resultado.success) {
    const detalles = resultado.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`);
    throw new ErrorConfiguracion('La configuración no cumple el esquema', detalles);
  }
  const config = resultado.data;
  const hallazgos: string[] = [];
  recorrer(config, config.id, hallazgos);
  hallazgos.push(...facetasSensibles(config));
  hallazgos.push(...paginasInvalidas(config));
  hallazgos.push(...recomiendaPlanConHerramienta(config));
  if (hallazgos.length > 0) throw new ErrorConfiguracion('La configuración contiene contenido no permitido', hallazgos);
  return config;
}

/** Parsea texto JSON y valida. */
export function cargarConfiguracionDesdeJson(texto: string): ConfiguracionAgente {
  let objeto: unknown;
  try {
    objeto = JSON.parse(texto);
  } catch (e) {
    throw new ErrorConfiguracion('El archivo no es JSON válido', [e instanceof Error ? e.message : String(e)]);
  }
  return validarConfiguracion(objeto);
}
