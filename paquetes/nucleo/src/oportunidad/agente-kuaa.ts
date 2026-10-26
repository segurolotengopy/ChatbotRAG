/**
 * AGENTE KUAA — respuesta estructurada para la oportunidad de venta
 *
 * Es un recorrido aparte de `Agente.responder` (no lo toca, para no arriesgar a SeguroLoTengo):
 * misma frontera de seguridad (saneo, compuertas de entrada y de salida, respaldo exigido, bitácora
 * sin texto) pero la salida es un `SalidaOportunidad` validado, no texto libre.
 *
 * Fallan cerrado: si el modelo no devuelve JSON válido, se corta por `max_tokens`, el texto trae un
 * enlace o un precio, o algo falla, la persona recibe el mensaje de error temporal con botones y
 * propuestas vacíos; jamás el texto crudo del modelo. `continuar_pago` solo sobrevive si SLT informó
 * `solicitud: completada`.
 *
 * Qué NO garantiza: que la etapa propuesta sea correcta (es una propuesta; valida SLT), que las
 * compuertas, calibradas con «usted», detecten todo voseo (hallazgo K2b), ni continuidad entre
 * instancias: la memoria es en proceso.
 */
import { createHash } from 'node:crypto';
import type { ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { estaOperativo } from '../configuracion/derivados.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { esCortesia } from '../compuertas/cortesia.js';
import { evaluarEntrada } from '../compuertas/entrada.js';
import { aplicarCompuertasSalida, extraerMarcas } from '../compuertas/salida.js';
import { sanearTexto } from '../compuertas/saneo.js';
import { hashConversacion, type DependenciasAgente } from '../orquestador/agente.js';
import { mensajeSinRespaldo } from '../prompt/armar.js';
import type { EventoBitacora } from '../puertos/bitacora.js';
import type { FragmentoRecuperado } from '../puertos/indice-conocimiento.js';
import { EntradaKuaa, SalidaOportunidad, filtrarBotonesSalida } from './esquemas.js';
import { armarPromptKuaa } from './prompt-kuaa.js';
import { contieneEnlaceOPrecio, interpretarSalidaModelo, salidaFallback } from './salida-kuaa.js';

export interface ResultadoKuaa {
  salida: SalidaOportunidad;
  /** Diagnóstico para la bitácora; no viaja al cliente. */
  avisos: string[];
}

export class AgenteKuaa {
  private readonly reloj: () => Date;

  constructor(private readonly deps: DependenciasAgente) {
    this.reloj = deps.reloj ?? (() => new Date());
  }

  async responder(crudo: EntradaKuaa): Promise<ResultadoKuaa> {
    const entrada = EntradaKuaa.parse(crudo);
    const config: ConfiguracionEfectiva = resolverConfiguracion(this.deps.config, null);
    const etapa = entrada.etapa_actual;
    const claveMemoria = `kuaa-${createHash('sha256').update(entrada.oportunidad_id).digest('hex').slice(0, 32)}`;
    const base: Pick<EventoBitacora, 'agenteId' | 'perfilId' | 'conversacionHash' | 'canal'> = {
      agenteId: config.id,
      perfilId: config.perfilId,
      conversacionHash: hashConversacion(claveMemoria),
      canal: 'kuaa',
    };
    const fallback = (avisos: string[], aviso: string): ResultadoKuaa => ({ salida: salidaFallback(config, etapa), avisos: [...avisos, aviso] });

    if (!estaOperativo(config)) {
      this.deps.bitacora.registrar({ ...base, tipo: 'suspendido' });
      return { salida: { ...salidaFallback(config, etapa), texto: config.mensajes.suspendido }, avisos: ['suspendido'] };
    }

    const texto = sanearTexto(entrada.mensaje, config.seguridad.maxCaracteresEntrada + 1);
    if (texto.length === 0 || texto.length > config.seguridad.maxCaracteresEntrada) return fallback([], 'mensaje_invalido');

    const ent = evaluarEntrada(texto, config.seguridad.bloquearEntrada, config.seguridad.vocabularioEntrada, config.seguridad.criterioSaludPep);
    if (ent.bloqueada) {
      const avisos = ent.bloqueantes.map((c) => `entrada:${c}`);
      this.deps.bitacora.registrar({ ...base, tipo: 'entrada_bloqueada', avisos });
      return { salida: { ...salidaFallback(config, etapa), texto: config.mensajes.entradaBloqueada }, avisos };
    }
    const avisos: string[] = ent.detectadas.map((c) => `detectada:${c}`);

    const historial = await this.deps.memoria.leer(claveMemoria, config.modelo.ventanaMemoria);

    let fragmentos: FragmentoRecuperado[] = [];
    if (config.conocimiento.modo === 'rag' && this.deps.indice && !esCortesia(texto)) {
      try {
        fragmentos = await this.deps.indice.buscar(texto, { coleccion: coleccionDe(this.deps.config, null), topK: config.conocimiento.topK, umbral: config.conocimiento.umbral });
      } catch {
        avisos.push('indice_error');
        this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice' });
      }
    }

    const sistema = armarPromptKuaa(config, entrada, fragmentos, this.reloj());
    const tokens = { tokensEntrada: 0, tokensSalida: 0 };
    let textoModelo = '';
    let cortado = false;
    try {
      const r = await this.deps.proveedor.generar({
        sistema,
        mensajes: [...historial.map((t) => ({ rol: t.rol, contenido: t.contenido })), { rol: 'usuario' as const, contenido: texto }],
        herramientas: [],
        parametros: { modelo: config.modelo.nombre, temperatura: config.modelo.temperatura, maxTokensSalida: config.modelo.maxTokensSalida, razonamiento: config.modelo.razonamiento },
      });
      tokens.tokensEntrada = r.uso.tokensEntrada;
      tokens.tokensSalida = r.uso.tokensSalida;
      textoModelo = r.texto;
      cortado = r.motivoFin === 'max_tokens';
    } catch {
      this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'proveedor', iteraciones: 1 });
      return fallback(avisos, 'error_modelo');
    }

    const interpretada = cortado ? null : interpretarSalidaModelo(textoModelo);
    if (cortado) return this.cerrar(base, fallback(avisos, 'respuesta_incompleta'), tokens, fragmentos);
    if (!interpretada) return this.cerrar(base, fallback(avisos, 'salida_invalida'), tokens, fragmentos);
    if (contieneEnlaceOPrecio(interpretada.texto)) return this.cerrar(base, fallback(avisos, 'enlace_o_precio'), tokens, fragmentos);

    let salida: SalidaOportunidad = interpretada;
    const esPregunta = /\?\s*$/.test(salida.texto.trim());
    if (config.conocimiento.modo === 'rag' && config.conocimiento.exigirRespaldo && fragmentos.length === 0 && !esCortesia(texto) && !esPregunta) {
      salida = { ...salida, texto: mensajeSinRespaldo(config), botones: [], propuestas: salida.propuestas.filter((p) => p === 'atencion_humana_solicitada') };
      avisos.push('sin_respaldo');
      this.deps.bitacora.registrar({ ...base, tipo: 'sin_respaldo' });
    }

    const marcas = extraerMarcas(salida.texto, config.seguridad.marcasPermitidas, config.seguridad.marcasLiterales);
    if (marcas.borradas > 0) avisos.push('marca_no_declarada');
    const compuertas = aplicarCompuertasSalida(marcas.texto, { config });
    avisos.push(...compuertas.avisos);
    if (compuertas.avisos.length) this.deps.bitacora.registrar({ ...base, tipo: 'compuerta_salida', avisos: compuertas.avisos });
    salida = compuertas.reemplazada ? { ...salida, texto: compuertas.texto, botones: [], propuestas: [] } : { ...salida, texto: compuertas.texto };

    const valida = SalidaOportunidad.safeParse(salida);
    if (!valida.success) return this.cerrar(base, fallback(avisos, 'salida_invalida'), tokens, fragmentos);
    const final = filtrarBotonesSalida(valida.data, entrada.estados);

    await this.deps.memoria.agregar(claveMemoria, [{ rol: 'usuario', contenido: texto }, { rol: 'asistente', contenido: final.texto }], config.modelo.ttlConversacionSeg);
    return this.cerrar(base, { salida: final, avisos }, tokens, fragmentos);
  }

  private cerrar(
    base: Pick<EventoBitacora, 'agenteId' | 'perfilId' | 'conversacionHash' | 'canal'>,
    resultado: ResultadoKuaa,
    tokens: { tokensEntrada: number; tokensSalida: number },
    fragmentos: FragmentoRecuperado[],
  ): ResultadoKuaa {
    this.deps.bitacora.registrar({
      ...base,
      tipo: 'mensaje_atendido',
      iteraciones: 1,
      ...tokens,
      avisos: [`etapa:${resultado.salida.etapa_propuesta}`, ...resultado.avisos],
      fragmentos: fragmentos.map((f) => f.id),
    });
    return resultado;
  }
}
