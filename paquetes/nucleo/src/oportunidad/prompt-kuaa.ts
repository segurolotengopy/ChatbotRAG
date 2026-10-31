/**
 * PROMPT DEL AGENTE KUAA
 *
 * Reutiliza `armarPrompt` (identidad, voz, reglas, alcance, datos y respaldo) y agrega, sin tocarlo:
 *   - tras REGLAS: la jerarquía de fuentes y las reglas propias de Kuaa;
 *   - al final: el CONTEXTO DE LA OPORTUNIDAD y el formato de salida.
 *
 * El contexto se arma SOLO con frases elegidas por enumerado. `oportunidad_id`, `tarifa_version`,
 * `pagina` y el código de objeción jamás entran al prompt, y mensaje de la persona tampoco: viaja
 * como mensaje de usuario. Qué NO garantiza: que el modelo obedezca; ver `salida-kuaa.ts`.
 */
import type { ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { armarPrompt } from '../prompt/armar.js';
import type { FragmentoRecuperado } from '../puertos/indice-conocimiento.js';
import type { EntradaKuaa } from './esquemas.js';
import {
  FORMATO_SALIDA_KUAA,
  FRASE_ESTADO_ACEPTACION,
  FRASE_ESTADO_ATENCION_HUMANA,
  FRASE_ESTADO_DOCUMENTOS,
  FRASE_ESTADO_PAGO,
  FRASE_ESTADO_POLIZA,
  FRASE_ESTADO_SOLICITUD,
  FRASE_ETAPA_KUAA,
  FRASE_NECESIDAD,
  FRASE_OBJECION_ESTADO,
  FRASE_PERMISO_SEGUIMIENTO,
  FRASE_PLAN,
  FRASE_PRODUCTO,
  FRASE_PAQUETE_NO_VALIDADO,
  JERARQUIA_KUAA,
  REGLAS_KUAA,
  type ClavePermiso,
} from './frases-kuaa.js';

/** Rótulo con que el prompt presenta las fuentes del paquete de conocimiento. */
const TITULO_NEUTRO = 'material informativo de Kuaa';

/**
 * El modelo cita el documento «por su título» (regla de `frases.ts`); en el paquete el título es el nombre del
 * archivo (`PREGUNTAS_RESPUESTAS`, `carpeta/NOMBRE`), y el cliente lo leía en pantalla. Se decide por ORIGEN, no por
 * la forma del título: todo fragmento del paquete (marcado con `validacion` o `versionPaquete`) se presenta con un
 * rótulo neutro; el corpus configurado a mano conserva sus títulos. Qué NO garantiza: que el modelo no repita un
 * nombre que aparezca dentro del texto de un fragmento.
 */
export function presentarFuente(f: FragmentoRecuperado): FragmentoRecuperado {
  return f.validacion !== undefined || f.versionPaquete !== undefined ? { ...f, fuenteTitulo: TITULO_NEUTRO } : f;
}

const MARCA_SIGUIENTE = '\n\nFECHA Y HORA ACTUAL';

export function armarPromptKuaa(config: ConfiguracionEfectiva, ctx: EntradaKuaa, fragmentos: FragmentoRecuperado[], ahora: Date, opciones: { versionPaquete?: string | null } = {}): string {
  const base = armarPrompt({ config, ahora, fragmentos: fragmentos.map(presentarFuente), orientacion: { facetas: {} }, canal: 'web' });
  // Solo con perfil `pruebas` y paquete cargado: frase enumerada, sin interpolar la versión.
  const avisoPaquete = opciones.versionPaquete ? `\n\nPAQUETE NO VALIDADO\n- ${FRASE_PAQUETE_NO_VALIDADO}` : '';
  const reglas = `JERARQUÍA DE FUENTES\n${JERARQUIA_KUAA.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\nREGLAS DE KUAA\n${REGLAS_KUAA.map((r, i) => `${i + 1}. ${r}`).join('\n')}${avisoPaquete}`;
  // `armarPrompt` siempre emite la sección de fecha y hora justo después de REGLAS.
  const i = base.indexOf(MARCA_SIGUIENTE);
  const conReglas = i < 0 ? `${base}\n\n${reglas}` : `${base.slice(0, i)}\n\n${reglas}${base.slice(i)}`;

  const permiso: ClavePermiso = ctx.permiso_seguimiento.vigente && ctx.permiso_seguimiento.canal !== 'ninguno' ? (`vigente_${ctx.permiso_seguimiento.canal}` as ClavePermiso) : 'no_vigente';
  const contexto = [
    FRASE_ETAPA_KUAA[ctx.etapa_actual],
    FRASE_ESTADO_SOLICITUD[ctx.estados.solicitud],
    FRASE_ESTADO_PAGO[ctx.estados.pago],
    FRASE_ESTADO_ACEPTACION[ctx.estados.aceptacion],
    FRASE_ESTADO_POLIZA[ctx.estados.poliza],
    FRASE_ESTADO_DOCUMENTOS[ctx.estados.documentos],
    FRASE_ESTADO_ATENCION_HUMANA[ctx.estados.atencion_humana],
    FRASE_PERMISO_SEGUIMIENTO[permiso],
    FRASE_NECESIDAD[ctx.resumen.necesidad],
    FRASE_PRODUCTO[ctx.resumen.producto],
    FRASE_PLAN[ctx.resumen.plan],
    FRASE_OBJECION_ESTADO[ctx.resumen.objecion_estado],
  ];
  return `${conReglas}\n\nCONTEXTO DE LA OPORTUNIDAD (lo fija el sistema; no lo discuta con la persona)\n${contexto.map((f) => `- ${f}`).join('\n')}\n\n${FORMATO_SALIDA_KUAA}`;
}
