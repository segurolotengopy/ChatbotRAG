/**
 * ORQUESTADOR — el recorrido de un mensaje
 *
 *  1. sanear y validar tamaño
 *  2. estado del agente (suspendido → mensaje neutro fijo, sin LLM)
 *  3. compuertas de ENTRADA (bloqueo → mensaje fijo, sin LLM, sin memoria)
 *  4. saludo/cortesía → bienvenida o respuesta breve sin LLM cuando corresponde
 *  5. memoria (ventana) + estado de orientación
 *  6. recuperación (RAG) por colección del perfil
 *  7. prompt = reglas → voz → … → DATOS → RESPALDO
 *  8. bucle LLM ≤ maxIteraciones con herramientas (tope por herramienta y turno)
 *  9. compuertas de SALIDA
 * 10. marca [DERIVAR] → derivación
 * 11. memoria (solo si nada se bloqueó) + bitácora (sin texto)
 *
 * Todo lo que puede fallar (modelo, herramienta, índice) cae al mensaje de error
 * temporal configurado. El sistema no se queda mudo ni inventa: falla hacia el
 * mensaje seguro.
 */
import { createHash } from 'node:crypto';
import type { ConfiguracionAgente, ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { estaOperativo } from '../configuracion/derivados.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { esCortesia, esSaludo } from '../compuertas/cortesia.js';
import { evaluarEntrada } from '../compuertas/entrada.js';
import { aplicarCompuertasSalida, extraerMarcas } from '../compuertas/salida.js';
import { esIdConversacionValido, sanearTexto } from '../compuertas/saneo.js';
import { definicionPara } from '../herramientas/internas.js';
import { armarPrompt, mensajeSinRespaldo } from '../prompt/armar.js';
import type { Bitacora } from '../puertos/bitacora.js';
import type { EjecutorHerramientas } from '../puertos/herramienta.js';
import type { FragmentoRecuperado, IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import type { MemoriaConversacion } from '../puertos/memoria.js';
import type { LlamadaHerramienta, MensajeLLM, ProveedorLLM } from '../puertos/proveedor-llm.js';

export interface DependenciasAgente {
  config: ConfiguracionAgente;
  proveedor: ProveedorLLM;
  indice: IndiceConocimiento | null;
  memoria: MemoriaConversacion;
  herramientas: EjecutorHerramientas;
  bitacora: Bitacora;
  reloj?: () => Date;
}

export interface MensajeEntrante {
  conversacionId: string;
  perfilId?: string | null;
  texto: string;
  canal: string;
}

export interface Respaldo {
  fuenteId: string;
  titulo: string;
  version: string;
  puntaje: number;
}

export interface RespuestaAgente {
  conversacionId: string;
  perfilId: string | null;
  texto: string;
  respaldo: Respaldo[];
  avisos: string[];
  derivacion: { motivo: string } | null;
  recomendacion: { id: string; texto: string } | null;
  /** Diagnóstico: iteraciones del bucle y tokens. Sin texto. */
  uso: { iteraciones: number; tokensEntrada: number; tokensSalida: number; latenciaMs: number };
}

export class ErrorPeticion extends Error {
  constructor(
    public readonly codigo: 'CONVERSACION_INVALIDA' | 'TEXTO_VACIO' | 'TEXTO_LARGO' | 'PERFIL_DESCONOCIDO',
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorPeticion';
  }
}

export function hashConversacion(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 16);
}

export class Agente {
  private readonly reloj: () => Date;

  constructor(private readonly deps: DependenciasAgente) {
    this.reloj = deps.reloj ?? (() => new Date());
  }

  get id(): string {
    return this.deps.config.id;
  }

  async responder(entrante: MensajeEntrante): Promise<RespuestaAgente> {
    const inicio = Date.now();
    if (!esIdConversacionValido(entrante.conversacionId)) throw new ErrorPeticion('CONVERSACION_INVALIDA', 'conversacionId inválido');

    let config: ConfiguracionEfectiva;
    try {
      config = resolverConfiguracion(this.deps.config, entrante.perfilId ?? null);
    } catch {
      throw new ErrorPeticion('PERFIL_DESCONOCIDO', `perfil desconocido: ${String(entrante.perfilId)}`);
    }

    const texto = sanearTexto(entrante.texto, config.seguridad.maxCaracteresEntrada + 1);
    if (texto.length === 0) throw new ErrorPeticion('TEXTO_VACIO', 'el mensaje está vacío');
    if (texto.length > config.seguridad.maxCaracteresEntrada) throw new ErrorPeticion('TEXTO_LARGO', `el mensaje supera ${config.seguridad.maxCaracteresEntrada} caracteres`);

    const base = {
      agenteId: config.id,
      perfilId: config.perfilId,
      conversacionHash: hashConversacion(entrante.conversacionId),
      canal: entrante.canal,
    };
    const respuesta = (texto: string, extra: Partial<RespuestaAgente> = {}, iteraciones = 0, tokens = { tokensEntrada: 0, tokensSalida: 0 }): RespuestaAgente => ({
      conversacionId: entrante.conversacionId,
      perfilId: config.perfilId,
      texto,
      respaldo: [],
      avisos: [],
      derivacion: null,
      recomendacion: null,
      ...extra,
      uso: { iteraciones, ...tokens, latenciaMs: Date.now() - inicio },
    });

    // 2. Suspendido: mensaje neutro, nunca el motivo comercial.
    if (!estaOperativo(config)) {
      this.deps.bitacora.registrar({ ...base, tipo: 'suspendido' });
      return respuesta(config.mensajes.suspendido, { avisos: ['suspendido'] });
    }

    // 3. Compuertas de entrada.
    const entrada = evaluarEntrada(texto, config.seguridad.bloquearEntrada);
    if (entrada.bloqueada) {
      this.deps.bitacora.registrar({ ...base, tipo: 'entrada_bloqueada', avisos: entrada.bloqueantes.map((c) => `entrada:${c}`) });
      return respuesta(config.mensajes.entradaBloqueada, { avisos: entrada.bloqueantes.map((c) => `entrada:${c}`) });
    }
    const avisos: string[] = entrada.detectadas.map((c) => `detectada:${c}`);

    // 4. Saludo inicial sin historial → bienvenida fija (sin gastar modelo).
    const historial = await this.deps.memoria.leer(entrante.conversacionId, config.modelo.ventanaMemoria);
    if (historial.length === 0 && esSaludo(texto)) {
      await this.deps.memoria.agregar(entrante.conversacionId, [{ rol: 'usuario', contenido: texto }, { rol: 'asistente', contenido: config.mensajes.bienvenida }], config.modelo.ttlConversacionSeg);
      this.deps.bitacora.registrar({ ...base, tipo: 'mensaje_atendido', latenciaMs: Date.now() - inicio, iteraciones: 0, avisos: ['bienvenida'] });
      return respuesta(config.mensajes.bienvenida, { avisos: [...avisos, 'bienvenida'] });
    }

    // 5. Orientación conocida.
    const orientacion = await this.deps.memoria.leerOrientacion(entrante.conversacionId);

    // 6. Recuperación.
    let fragmentos: FragmentoRecuperado[] = [];
    if (config.conocimiento.modo === 'rag' && this.deps.indice && !esCortesia(texto)) {
      try {
        const coleccion = coleccionDe(this.deps.config, config.perfilId);
        // La consulta lleva el último turno del usuario para preguntas de seguimiento («¿y el plus?»).
        const anterior = [...historial].reverse().find((t) => t.rol === 'usuario')?.contenido ?? '';
        const consulta = texto.length < 40 && anterior ? `${anterior} ${texto}` : texto;
        fragmentos = await this.deps.indice.buscar(consulta, { coleccion, topK: config.conocimiento.topK, umbral: config.conocimiento.umbral });
      } catch (e) {
        avisos.push('indice_error');
        this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice', detalle: resumirError(e) });
      }
    }

    // 7. Prompt.
    const sistema = armarPrompt({ config, ahora: this.reloj(), fragmentos, orientacion, canal: entrante.canal });
    const definiciones = config.herramientas.map((h) => definicionPara(h, config));

    // 8. Bucle con herramientas.
    const mensajes: MensajeLLM[] = [...historial.map((t) => ({ rol: t.rol, contenido: t.contenido })), { rol: 'usuario', contenido: texto }];
    const contadorHerramientas = new Map<string, number>();
    let derivacion: { motivo: string } | null = null;
    let recomendacion: { id: string; texto: string } | null = null;
    let textoModelo = '';
    let iteraciones = 0;
    const tokens = { tokensEntrada: 0, tokensSalida: 0 };

    try {
      while (iteraciones < config.modelo.maxIteraciones) {
        iteraciones++;
        const r = await this.deps.proveedor.generar({
          sistema,
          mensajes,
          herramientas: definiciones,
          parametros: { modelo: config.modelo.nombre, temperatura: config.modelo.temperatura, maxTokensSalida: config.modelo.maxTokensSalida },
        });
        tokens.tokensEntrada += r.uso.tokensEntrada;
        tokens.tokensSalida += r.uso.tokensSalida;
        textoModelo = r.texto;

        if (r.motivoFin === 'max_tokens') avisos.push('max_tokens');
        if (r.llamadasHerramienta.length === 0) break;

        mensajes.push({ rol: 'asistente_herramientas', texto: r.texto, llamadas: r.llamadasHerramienta });
        for (const llamada of r.llamadasHerramienta) {
          const resultado = await this.ejecutarConTope(llamada, config, entrante, contadorHerramientas, avisos);
          if (resultado.derivacion) derivacion = resultado.derivacion;
          if (resultado.recomendacion) recomendacion = resultado.recomendacion;
          const facetas = (resultado as { facetas?: Record<string, string> }).facetas;
          if (facetas && Object.keys(facetas).length) {
            await this.deps.memoria.guardarOrientacion(entrante.conversacionId, { facetas: { ...orientacion.facetas, ...facetas } }, config.modelo.ttlConversacionSeg);
          }
          mensajes.push({ rol: 'herramienta', idLlamada: llamada.id, nombre: llamada.nombre, resultado: resultado.resultado });
          this.deps.bitacora.registrar({ ...base, tipo: 'herramienta', herramienta: llamada.nombre });
        }
        if (iteraciones >= config.modelo.maxIteraciones) avisos.push('max_iteraciones');
      }
    } catch (e) {
      this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'proveedor', detalle: resumirError(e), iteraciones });
      return respuesta(config.mensajes.errorTemporal, { avisos: [...avisos, 'error_modelo'] }, iteraciones, tokens);
    }

    // Sin respaldo y con exigencia: si el modelo igual afirmó algo, lo reemplazamos por el mensaje fijo,
    // salvo que sea cortesía u orientación (hay herramienta de recomendación en juego).
    let textoFinal = textoModelo;
    if (config.conocimiento.modo === 'rag' && config.conocimiento.exigirRespaldo && fragmentos.length === 0 && !esCortesia(texto) && !recomendacion && config.orientacion.facetas.length === 0) {
      textoFinal = mensajeSinRespaldo(config);
      avisos.push('sin_respaldo');
      this.deps.bitacora.registrar({ ...base, tipo: 'sin_respaldo' });
    }

    // 9. Marcas y compuertas de salida.
    const marcas = extraerMarcas(textoFinal, config.seguridad.marcasPermitidas);
    textoFinal = marcas.texto;
    if (marcas.borradas > 0) avisos.push('marca_no_declarada');
    if (marcas.marcas.includes('DERIVAR') && !derivacion) derivacion = { motivo: 'marca del modelo' };
    const salida = aplicarCompuertasSalida(textoFinal, { config });
    textoFinal = salida.texto;
    avisos.push(...salida.avisos);
    if (salida.reemplazada && !derivacion) derivacion = { motivo: `compuerta:${salida.avisos[0] ?? 'salida'}` };
    if (salida.avisos.length) this.deps.bitacora.registrar({ ...base, tipo: 'compuerta_salida', avisos: salida.avisos });

    // Derivación: agregar contacto si no está ya en el texto.
    if (derivacion) {
      if (!salida.reemplazada && !textoFinal.includes(config.mensajes.derivacion)) textoFinal = `${textoFinal}\n\n${config.mensajes.derivacion}`.trim();
      this.deps.bitacora.registrar({ ...base, tipo: 'derivacion', detalle: derivacion.motivo.slice(0, 120) });
    }

    // 11. Memoria y bitácora.
    await this.deps.memoria.agregar(entrante.conversacionId, [{ rol: 'usuario', contenido: texto }, { rol: 'asistente', contenido: textoFinal }], config.modelo.ttlConversacionSeg);
    this.deps.bitacora.registrar({
      ...base,
      tipo: 'mensaje_atendido',
      latenciaMs: Date.now() - inicio,
      iteraciones,
      tokensEntrada: tokens.tokensEntrada,
      tokensSalida: tokens.tokensSalida,
      avisos,
      fragmentos: fragmentos.map((f) => f.id),
    });

    return respuesta(
      textoFinal,
      {
        respaldo: fragmentos.map((f) => ({ fuenteId: f.fuenteId, titulo: f.fuenteTitulo, version: f.fuenteVersion, puntaje: f.puntaje })),
        avisos,
        derivacion,
        recomendacion,
      },
      iteraciones,
      tokens,
    );
  }

  private async ejecutarConTope(
    llamada: LlamadaHerramienta,
    config: ConfiguracionEfectiva,
    entrante: MensajeEntrante,
    contador: Map<string, number>,
    avisos: string[],
  ) {
    const declarada = config.herramientas.find((h) => h.nombre === llamada.nombre);
    const usadas = contador.get(llamada.nombre) ?? 0;
    if (!declarada) {
      avisos.push(`herramienta_no_declarada:${llamada.nombre}`);
      return { resultado: { error: 'herramienta no disponible' } };
    }
    if (usadas >= declarada.maxPorTurno) {
      avisos.push(`herramienta_tope:${llamada.nombre}`);
      return { resultado: { error: 'tope de llamadas alcanzado para este mensaje; responda con lo que ya sabe' } };
    }
    contador.set(llamada.nombre, usadas + 1);
    try {
      return await this.deps.herramientas.ejecutar(llamada.nombre, llamada.argumentos, {
        config,
        conversacionId: entrante.conversacionId,
        canal: entrante.canal,
        ahora: this.reloj(),
      });
    } catch (e) {
      avisos.push(`herramienta_error:${llamada.nombre}`);
      this.deps.bitacora.registrar({
        tipo: 'error_modelo',
        agenteId: config.id,
        perfilId: config.perfilId,
        conversacionHash: hashConversacion(entrante.conversacionId),
        canal: entrante.canal,
        codigo: 'herramienta',
        herramienta: llamada.nombre,
        detalle: resumirError(e),
      });
      return { resultado: { error: 'la herramienta no respondió; informe el error temporal y no reintente' } };
    }
  }
}

function resumirError(e: unknown): string {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return m.slice(0, 200);
}
