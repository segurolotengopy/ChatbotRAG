/**
 * ORQUESTADOR — el recorrido de un mensaje
 *
 *  1. sanear y validar tamaño
 *  2. estado del agente (suspendido → mensaje neutro fijo, sin LLM)
 *  3. compuertas de ENTRADA (bloqueo → mensaje fijo, sin LLM, sin memoria)
 *  4. saludo/cortesía → bienvenida o respuesta breve sin LLM cuando corresponde
 *  5. memoria (ventana) + estado de orientación
 *  6. recuperación (RAG) por colección del perfil; con `pagina` válida, el manual de esa
 *     pantalla va primero y cuenta como respaldo
 *  7. prompt = reglas → voz → … → DATOS → RESPALDO
 *  8. bucle LLM ≤ maxIteraciones con herramientas (tope por herramienta y turno)
 *  9. compuertas de SALIDA
 * 10. marca [DERIVAR] → derivación
 * 11. memoria (solo si nada se bloqueó) + bitácora (sin texto)
 *
 * CONTEXTO DE PÁGINA. `pagina` es el único valor del cliente que decide qué documento entra
 * al prompt, y solo por SELECCIÓN: se compara con `conocimiento.paginas` del perfil vigente y,
 * si coincide, se trae la fuente que la configuración le asignó. Un valor que no coincide (o
 * que no es una cadena con forma de id) se ignora con el aviso `pagina_desconocida`: nunca es
 * un error HTTP, nunca se registra y nunca entra al prompt. El manual se recorta a
 * `maxCaracteresPagina` por fragmentos completos (aviso `pagina_recortada`); si falla su lectura,
 * aviso `pagina_error` y la búsqueda sigue. Sin coincidencias de búsqueda, el manual solo vale
 * como respaldo si el mensaje trae un deíctico (`RE_DEICTICO_PAGINA`). La bitácora lleva
 * solo el id ya validado. El contexto NO se persiste en memoria ni en la orientación: viaja
 * en cada mensaje. Lo que NO garantiza: que la persona esté en esa pantalla (el sitio lo
 * declara); por eso la frase del prompt prohíbe afirmar qué completó o qué ve.
 *
 * Todo lo que puede fallar (modelo, herramienta, índice) cae al mensaje de error
 * temporal configurado. El sistema no se queda mudo ni inventa: falla hacia el
 * mensaje seguro.
 */
import { createHash } from 'node:crypto';
import { ID_PAGINA, type ConfiguracionAgente, type ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { estaOperativo } from '../configuracion/derivados.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { esCortesia, esSaludo } from '../compuertas/cortesia.js';
import { evaluarEntrada } from '../compuertas/entrada.js';
import { aplicarCompuertasSalida, extraerMarcas } from '../compuertas/salida.js';
import { esIdConversacionValido, sanearTexto } from '../compuertas/saneo.js';
import { normalizar } from '../compuertas/vocabulario.js';
import { definicionPara } from '../herramientas/internas.js';
import { armarPrompt, mensajeSinRespaldo } from '../prompt/armar.js';
import type { Bitacora } from '../puertos/bitacora.js';
import type { EjecutorHerramientas } from '../puertos/herramienta.js';
import type { FragmentoRecuperado, IndiceConocimiento } from '../puertos/indice-conocimiento.js';
import type { MemoriaConversacion } from '../puertos/memoria.js';
import type { LlamadaHerramienta, MensajeLLM, ProveedorLLM } from '../puertos/proveedor-llm.js';

/**
 * RELACIÓN CON LA PÁGINA. Con página válida el manual entra al respaldo, pero eso no debe
 * volver respondible cualquier pregunta: sin coincidencias de búsqueda, el manual solo
 * cuenta si el mensaje (normalizado) contiene uno de estos deícticos. Es un conjunto CERRADO
 * escrito por nosotros; el texto del cliente solo se compara con él, no define comportamiento.
 * Límite conocido: una pregunta relacionada con la pantalla, sin deíctico y sin coincidencia
 * léxica en el corpus cae en `sin_respaldo` (falla hacia lo seguro, no hacia inventar).
 */
export const RE_DEICTICO_PAGINA = /\b(esta pantalla|esta pagina|aca|aqui|este paso|este campo|este boton|esta seccion|esta etapa|donde estoy|en que paso)\b/;

/** Fragmentos del manual que se piden al índice; si hay más, se avisa `pagina_recortada`. */
const LIMITE_FRAGMENTOS_PAGINA = 20;

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
  /** Id de pantalla declarado por el sitio. Se valida contra `conocimiento.paginas`; cualquier otro valor se ignora. */
  pagina?: string | null;
  texto: string;
  canal: string;
}

export interface Respaldo {
  fuenteId: string;
  titulo: string;
  version: string;
  /** Para `origen: 'pagina'` es 1 por convención: el manual se inyecta, no se puntúa. */
  puntaje: number;
  origen: 'pagina' | 'busqueda';
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
    const entrada = evaluarEntrada(texto, config.seguridad.bloquearEntrada, config.seguridad.vocabularioEntrada);
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
    let fragmentosPagina: FragmentoRecuperado[] = [];
    let paginaId: string | undefined;
    if (config.conocimiento.modo === 'rag' && this.deps.indice && !esCortesia(texto)) {
      const indice = this.deps.indice;
      const coleccion = coleccionDe(this.deps.config, config.perfilId);
      const pedida = entrante.pagina;
      const paginaValida = typeof pedida === 'string' && ID_PAGINA.test(pedida) ? config.conocimiento.paginas.find((p) => p.id === pedida) : undefined;
      if (pedida !== null && pedida !== undefined && !paginaValida) avisos.push('pagina_desconocida');

      // Manual de la pantalla: con su propio try, para que un fallo de lectura no se lleve el top-K.
      if (paginaValida) {
        try {
          const tope = LIMITE_FRAGMENTOS_PAGINA;
          const candidatos = await indice.fragmentosDeFuente(coleccion, paginaValida.fuenteId, tope + 1);
          let recortada = candidatos.length > tope;
          let usados = 0;
          for (const c of candidatos.slice(0, tope)) {
            if (usados + c.texto.length > config.conocimiento.maxCaracteresPagina) {
              recortada = true;
              break;
            }
            usados += c.texto.length;
            fragmentosPagina.push({ ...c, puntaje: 1 });
          }
          if (recortada) avisos.push('pagina_recortada');
          // Sin fragmentos inyectados la página no se usó: la bitácora no dice que sí.
          if (fragmentosPagina.length > 0) paginaId = paginaValida.id;
        } catch (e) {
          fragmentosPagina = [];
          avisos.push('pagina_error');
          this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'pagina', detalle: resumirError(e) });
        }
      }

      let encontrados: FragmentoRecuperado[] = [];
      try {
        // La consulta lleva el último turno del usuario para preguntas de seguimiento («¿y el plus?»).
        const anterior = [...historial].reverse().find((t) => t.rol === 'usuario')?.contenido ?? '';
        const consulta = texto.length < 40 && anterior ? `${anterior} ${texto}` : texto;
        encontrados = await indice.buscar(consulta, { coleccion, topK: config.conocimiento.topK, umbral: config.conocimiento.umbral });
      } catch (e) {
        avisos.push('indice_error');
        this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice', detalle: resumirError(e) });
      }

      // El manual solo cuenta como respaldo si la búsqueda encontró algo o la pregunta se refiere a la
      // pantalla (deíctico). Si no, una pregunta ajena («tasa del crédito») pasaría sin freno con solo
      // estar en una página con manual: se sigue el camino de `sin_respaldo` de siempre.
      if (fragmentosPagina.length > 0 && encontrados.length === 0 && !RE_DEICTICO_PAGINA.test(normalizar(texto))) fragmentosPagina = [];
      const idsPagina = new Set(fragmentosPagina.map((f) => f.id));
      fragmentos = [...fragmentosPagina, ...encontrados.filter((f) => !idsPagina.has(f.id))];
    }

    // 7. Prompt.
    const sistema = armarPrompt({ config, ahora: this.reloj(), fragmentos, orientacion, canal: entrante.canal, fragmentosPagina: fragmentosPagina.length });
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

    // SIN RESPALDO Y CON EXIGENCIA: si no hubo fragmentos, el modelo no llamó a ninguna
    // herramienta y su texto no es una pregunta (una pregunta de orientación o de
    // aclaración no afirma nada), lo que haya dicho se reemplaza por el mensaje fijo.
    // Es una heurística deliberadamente conservadora: prefiere derivar a inventar.
    let textoFinal = textoModelo;
    const huboHerramienta = contadorHerramientas.size > 0;
    const esPregunta = /\?\s*$/.test(textoModelo.trim());
    if (config.conocimiento.modo === 'rag' && config.conocimiento.exigirRespaldo && fragmentos.length === 0 && !esCortesia(texto) && !huboHerramienta && !esPregunta) {
      textoFinal = mensajeSinRespaldo(config);
      avisos.push('sin_respaldo');
      this.deps.bitacora.registrar({ ...base, tipo: 'sin_respaldo', ...(paginaId ? { pagina: paginaId } : {}) });
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
      ...(paginaId ? { pagina: paginaId } : {}),
    });

    return respuesta(
      textoFinal,
      {
        respaldo: respaldoDe(fragmentos, fragmentosPagina.length),
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

/** El manual de la pantalla figura UNA vez por fuente (puntaje 1: inyectado); la búsqueda, fragmento a fragmento como siempre. */
function respaldoDe(fragmentos: FragmentoRecuperado[], cantidadPagina: number): Respaldo[] {
  const salida: Respaldo[] = [];
  const vistas = new Set<string>();
  fragmentos.forEach((f, i) => {
    if (i < cantidadPagina) {
      if (vistas.has(f.fuenteId)) return;
      vistas.add(f.fuenteId);
      salida.push({ fuenteId: f.fuenteId, titulo: f.fuenteTitulo, version: f.fuenteVersion, puntaje: 1, origen: 'pagina' });
    } else {
      salida.push({ fuenteId: f.fuenteId, titulo: f.fuenteTitulo, version: f.fuenteVersion, puntaje: f.puntaje, origen: 'busqueda' });
    }
  });
  return salida;
}

function resumirError(e: unknown): string {
  const m = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return m.slice(0, 200);
}
