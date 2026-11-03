/**
 * VARIABLES DE PLANTILLA DESDE LA PLATAFORMA
 *
 * Por qué existe: las plantillas del banco de respuestas se rellenan con los datos de la plataforma (planes y
 * contacto) formateados por código con las mismas funciones que arman el prompt (`formato-plataforma.ts`), de modo
 * que el detector de la salida reconozca esas cifras como permitidas.
 *
 * Defecto que motiva el control: un importe escrito a mano o con otro formato en una respuesta sería rechazado por
 * el detector de precios, o peor, afirmaría una cifra distinta de la vigente. Aquí el dato siempre sale de la fuente.
 *
 * Qué NO garantiza: que los datos de la plataforma sean correctos (los fija SLT). Todo dato ausente devuelve `null`;
 * quien rellena decide qué hacer (derivar), nunca se inventa un valor.
 */
import type { ResolverVariables } from '../banco/plantillas.js';
import type { VariablePlantilla } from '../banco/esquema.js';
import type { Plataforma, PlanPlataforma, ResumenOportunidad } from './esquemas.js';
import { formatearGs, formatearTelefono } from './formato-plataforma.js';

const DE_PLAN: Record<string, (p: PlanPlataforma) => string> = {
  nombre_plan: (p) => p.nombre,
  premio_plan: (p) => formatearGs(p.premio_anual_gs),
  capital_fallecimiento_plan: (p) => formatearGs(p.capital_fallecimiento_gs),
  indemnizacion_cancer_plan: (p) => formatearGs(p.indemnizacion_cancer_gs),
  renta_hospitalaria_dia_plan: (p) => formatearGs(p.renta_hospitalaria_dia_gs),
  renta_dias_max_plan: (p) => String(p.renta_dias_max),
  gastos_medicos_accidente_plan: (p) => formatearGs(p.gastos_medicos_accidente_gs),
};

export function resolverVariablesPlataforma(plataforma: Plataforma | undefined, plan: ResumenOportunidad['plan']): ResolverVariables {
  return (v: VariablePlantilla): string | null => {
    if (!plataforma) return null;
    const deplan = DE_PLAN[v];
    if (deplan) {
      if (plan === 'ninguno') return null;
      const elegido = plataforma.planes.find((p) => p.plan === plan);
      return elegido ? deplan(elegido) : null;
    }
    const { whatsapp_e164: tel, canal, correo_derechos: correo } = plataforma.contacto;
    switch (v) {
      case 'whatsapp':
        return tel === undefined ? null : formatearTelefono(tel);
      case 'canal_contacto':
        return canal ?? null;
      case 'correo_derechos':
        return correo ?? null;
      default:
        return null;
    }
  };
}
