/**
 * TEXTO FIJO VERIFICADO POR LAS COMPUERTAS DE SALIDA (modelo híbrido, H2)
 *
 * Por qué existe: cierra el pendiente de H1. El texto que se arma desde el banco (plantilla rellenada o texto de
 * derivación) pasa SIEMPRE por las compuertas de salida antes de llegar a una persona. Si no sale limpio (una
 * compuerta lo reemplazó, dejó un aviso o lo modificó) se DESCARTA, no se corrige: un texto aprobado que una
 * compuerta objeta es un defecto del banco o de los datos, y el sistema cae al carril siguiente.
 *
 * Defecto que motiva el control: un valor resuelto con forma de tarjeta, una marca no declarada o una frase que
 * niega ser una IA, metidos por una variable o por un texto mal aprobado, saldrían con la autoridad de «texto
 * aprobado». Los resultados de falla jamás llevan el texto, los valores resueltos ni `aprobado_por`.
 *
 * Qué NO garantiza: que el texto sea correcto o conveniente (eso lo da `aprobado_por`), ni que las compuertas
 * detecten todo. `VerificadorAdicional` es el gancho para detectores propios de un agente (por ejemplo, precios
 * no permitidos), de modo que el núcleo no importe `oportunidad/`. Si no hay texto de derivación en el banco,
 * se informa `sin_texto` con el carril `derivacion`: H4 usará `config.mensajes.derivacion`.
 */
import { aplicarCompuertasSalida } from '../compuertas/salida.js';
import type { ContextoSalida } from '../compuertas/salida.js';
import type { DecisionDerivacion, DecisionFijo } from './enrutador.js';
import type { BancoRespuestas, MotivoDerivacion } from './esquema.js';
import { ErrorPlantilla, rellenarPlantilla } from './plantillas.js';
import type { ResolverVariables } from './plantillas.js';

export const CAUSAS_RECHAZO_TEXTO = ['sin_texto', 'faltan_datos', 'plantilla_invalida', 'compuerta_salida', 'verificacion_adicional'] as const;
export type CausaRechazoTexto = (typeof CAUSAS_RECHAZO_TEXTO)[number];

/** Devuelve un código corto (/^[a-z0-9_:]{1,40}$/) si el texto no es admisible, o `null` si lo es. */
export type VerificadorAdicional = (texto: string) => string | null;

export type ResultadoTextoFijo =
  | { ok: true; texto: string }
  | { ok: false; causa: CausaRechazoTexto; avisos: string[]; carrilSiguiente: 'ia' }
  | { ok: false; causa: CausaRechazoTexto; avisos: string[]; carrilSiguiente: 'derivacion'; motivo: MotivoDerivacion };

const CODIGO_VERIFICACION = /^[a-z0-9_:]{1,40}$/;

const haciaIa = (causa: CausaRechazoTexto, avisos: string[] = []): ResultadoTextoFijo => ({ ok: false, causa, avisos, carrilSiguiente: 'ia' });
const haciaDerivacion = (causa: CausaRechazoTexto, motivo: MotivoDerivacion, avisos: string[] = []): ResultadoTextoFijo => ({
  ok: false,
  causa,
  avisos,
  carrilSiguiente: 'derivacion',
  motivo,
});

/** Aplica las compuertas; el texto solo sirve si salen sin tocarlo ni avisar nada. */
function revisar(
  texto: string,
  ctx: ContextoSalida,
  verificarAdicional: VerificadorAdicional | undefined,
  falla: (causa: CausaRechazoTexto, avisos: string[]) => ResultadoTextoFijo,
): ResultadoTextoFijo {
  const r = aplicarCompuertasSalida(texto, ctx);
  if (r.reemplazada || r.avisos.length > 0 || r.texto !== texto) return falla('compuerta_salida', r.avisos);
  const codigo = verificarAdicional?.(texto) ?? null;
  if (codigo !== null) return falla('verificacion_adicional', [CODIGO_VERIFICACION.test(codigo) ? codigo : 'verificacion_adicional']);
  return { ok: true, texto };
}

export function armarTextoFijo(
  decision: DecisionFijo | DecisionDerivacion,
  banco: BancoRespuestas,
  resolver: ResolverVariables,
  ctx: ContextoSalida,
  verificarAdicional?: VerificadorAdicional,
): ResultadoTextoFijo {
  if (decision.carril === 'fijo') {
    const entrada = banco.respuestas.find((e) => e.id === decision.entradaId);
    if (!entrada) return haciaIa('sin_texto');

    let relleno: ReturnType<typeof rellenarPlantilla>;
    try {
      relleno = rellenarPlantilla(entrada.plantilla, resolver);
    } catch (e) {
      if (e instanceof ErrorPlantilla) return haciaIa('plantilla_invalida');
      throw e;
    }
    if (!relleno.ok) {
      return entrada.derivar_cuando.includes('sin_dato') ? haciaDerivacion('faltan_datos', 'contenido_pendiente') : haciaIa('faltan_datos');
    }
    return revisar(relleno.texto, ctx, verificarAdicional, (causa, avisos) => haciaIa(causa, avisos));
  }

  const motivo = decision.motivo;
  const propia = banco.derivaciones.find((d) => d.id === decision.entradaId && d.motivo === motivo);
  const texto = propia?.texto ?? banco.textos_derivacion.find((t) => t.motivo === motivo)?.texto;
  if (texto === undefined) return haciaDerivacion('sin_texto', motivo);
  if (/[{}]/.test(texto)) return haciaDerivacion('plantilla_invalida', motivo);
  return revisar(texto, ctx, verificarAdicional, (causa, avisos) => haciaDerivacion(causa, motivo, avisos));
}

/** Aplica `armarTextoFijo` a todo el banco y devuelve solo los fallos (para validar un banco antes de publicarlo). */
export function verificarBanco(
  banco: BancoRespuestas,
  resolver: ResolverVariables,
  ctx: ContextoSalida,
  verificarAdicional?: VerificadorAdicional,
): ReadonlyArray<{ id: string; causa: CausaRechazoTexto }> {
  const fallos: { id: string; causa: CausaRechazoTexto }[] = [];
  const probar = (id: string, decision: DecisionFijo | DecisionDerivacion) => {
    const r = armarTextoFijo(decision, banco, resolver, ctx, verificarAdicional);
    if (!r.ok) fallos.push({ id, causa: r.causa });
  };
  for (const e of banco.respuestas) probar(e.id, { carril: 'fijo', entradaId: e.id, tema: e.tema, riesgo: e.riesgo });
  for (const d of banco.derivaciones) probar(d.id, { carril: 'derivacion', motivo: d.motivo, origen: 'pregunta_derivacion', entradaId: d.id });
  for (const t of banco.textos_derivacion) {
    const id = `motivo:${t.motivo}`;
    probar(id, { carril: 'derivacion', motivo: t.motivo, origen: 'condicion_entrada', entradaId: id });
  }
  return fallos;
}
