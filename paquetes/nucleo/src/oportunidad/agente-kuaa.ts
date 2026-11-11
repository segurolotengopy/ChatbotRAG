/**
 * AGENTE KUAA — respuesta estructurada para la oportunidad de venta
 *
 * Es un recorrido aparte de `Agente.responder` (no lo toca, para no arriesgar a SeguroLoTengo):
 * misma frontera de seguridad (saneo, compuertas de entrada y de salida, respaldo exigido, bitácora
 * sin texto) pero la salida es un `SalidaOportunidad` validado, no texto libre.
 *
 * Fallan cerrado: si el modelo no devuelve JSON válido, se corta por `max_tokens`, el texto trae un
 * enlace, un precio, una afirmación de hecho que solo el sistema conoce (pago, póliza, agenda, traspaso,
 * cobertura) o una fuga del prompt, o algo falla, la persona recibe el mensaje de error temporal con
 * botones y propuestas vacíos; jamás el texto crudo del modelo. Una afirmación contraria a la base
 * (`afirmaciones-contra-base.ts`) primero se corrige reintentando al modelo UNA vez con una frase fija por motivo; si
 * persiste, se retira la oración (más la derivación) o, si no queda nada útil, se responde «sin respaldo» con la derivación. `continuar_pago` solo sobrevive si SLT
 * informó `solicitud: completada`. La entrada se normaliza ANTES de las compuertas (invisibles, marcas
 * combinantes, homóglifos) y el modelo recibe el texto normalizado.
 *
 * Contrato v0.4: con `plataforma` el modelo puede decir los importes, teléfonos y correos de ese bloque (y solo esos:
 * el detector retira esas apariciones exactas antes de aplicar sus patrones). El bloque no se guarda en la memoria ni en la
 * bitácora; de él solo queda su versión en un aviso.
 *
 * La memoria es en proceso, por cliente y por oportunidad, y guarda el texto de la persona y el JSON
 * validado de la respuesta hasta `ttlConversacionSeg` (el contrato de SLT dice «sin estado»: es una
 * desviación declarada). Su clave lleva «:», que `ID_CONVERSACION` no acepta: las rutas generales no pueden
 * nombrarla.
 *
 * Qué NO garantiza: que la etapa propuesta sea correcta (es una propuesta; valida SLT); que las
 * compuertas compartidas, calibradas con «usted», detecten todo voseo ni que sus reemplazos hablen de vos
 * («¿En qué puedo ayudarle?»): límite K2b; paráfrasis de inyección como «olvidá lo anterior» o «SYSTEM:».
 */
import { createHash } from 'node:crypto';
import type { ConfiguracionEfectiva } from '../configuracion/esquema.js';
import { estaOperativo } from '../configuracion/derivados.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { coleccionDe } from '../conocimiento/cargar-corpus.js';
import { coleccionPaquete } from '../conocimiento/cargar-paquete.js';
import type { PerfilValidacion } from '../conocimiento/registros-habilitados.js';
import { esCortesia } from '../compuertas/cortesia.js';
import { evaluarEntrada } from '../compuertas/entrada.js';
import { aplicarCompuertasSalida, extraerMarcas } from '../compuertas/salida.js';
import { sanearTexto } from '../compuertas/saneo.js';
import { ErrorPeticion, hashConversacion, type DependenciasAgente } from '../orquestador/agente.js';
import type { EventoBitacora } from '../puertos/bitacora.js';
import { causaDeError, type CausaErrorProveedor } from '../puertos/proveedor-llm.js';
import type { FragmentoRecuperado } from '../puertos/indice-conocimiento.js';
import { afirmaContraBase, CORRECCION_POR_MOTIVO, quitarAfirmacionesContraBase } from './afirmaciones-contra-base.js';
import { EntradaKuaa, SalidaOportunidad, filtrarBotonesSalida } from './esquemas.js';
import { normalizarEntradaKuaa } from './normalizar-entrada.js';
import { armarPromptKuaa } from './prompt-kuaa.js';
import { fraseDerivacionKuaa, afirmaHechoNoRespaldado, afirmaTratamientoTributario, quitarFrases, salvarQuitandoBloqueado, quitarPromesasDeEntrega, quitarSaludoInicial, retirarNumerosDeRegistro, salidaTributaria, patronEnlaceOPrecio, permitidosDe, analizarSalida, filtraPrompt, retirarCodigosInternos, salidaFallback, salidaSinCifras, textoSinRespaldo } from './salida-kuaa.js';

export interface ResultadoKuaa {
  salida: SalidaOportunidad;
  /** Diagnóstico para la bitácora; no viaja al cliente. */
  avisos: string[];
}

type BaseBitacora = Pick<EventoBitacora, 'agenteId' | 'perfilId' | 'conversacionHash' | 'canal'>;

/** Clave de memoria: por cliente y oportunidad; el «:» impide que una ruta general la nombre. */
export function claveMemoriaKuaa(clienteId: string, oportunidadId: string): string {
  return `kuaa:${clienteId}:${createHash('sha256').update(`${clienteId}\0${oportunidadId}`).digest('hex')}`;
}

/**
 * Reintentos ante una salida que no es JSON legible: una llamada extra como máximo, y solo si desde que llegó la petición
 * pasaron como mucho `TIEMPO_MAXIMO_PARA_REINTENTAR_MS` (búsqueda RAG incluida). Reduce la probabilidad de pasar el tope de
 * 20 s del sitio; NO lo garantiza (ver docs/ARQUITECTURA.md). El reintento por afirmación contraria a la base (uno solo)
 * comparte esa guarda de tiempo, y entre los dos nunca pasan de `MAX_REINTENTOS_POR_TURNO` llamadas extra.
 */
const REINTENTOS_FORMATO = 1;
const REINTENTOS_CONTRA_BASE = 1;
const MAX_REINTENTOS_POR_TURNO = 2;
const TIEMPO_MAXIMO_PARA_REINTENTAR_MS = 3000;
/** Lo que debe quedar de una respuesta tras quitarle una frase para seguir valiendo («¿Ok?» solo no ayuda a nadie). */
const RESTO_MINIMO = 30;

/** Cuota o saturación: falla de infraestructura que se dice como «alta demanda». */
function esAltaDemanda(causa: CausaErrorProveedor): boolean {
  return causa === 'cuota' || causa === 'saturacion';
}

/**
 * Tiempo agotado o error del servidor del embebedor: falla de infraestructura, no falta de información (evidencia: 2 de 541
 * mensajes de la corrida de staging del 7-nov-2026 terminaron en «No tengo información aprobada» por causa `tiempo`, y al
 * repetirse salían bien). Se dice «problema técnico momentáneo». Las causas `autenticacion`, `modelo` y `otro` NO entran aquí a
 * propósito: son errores de configuración o de petición, que reintentar no arregla, y siguen a `sin_respaldo` como antes.
 * Política pendiente de confirmar con Andres si se quisiera cambiar.
 */
function esErrorTemporalIndice(causa: CausaErrorProveedor): boolean {
  return causa === 'tiempo' || causa === 'servidor';
}

/** Devuelve el aviso enumerado si la causa del fallo del índice debe cortar el turno con un mensaje de infraestructura. */
function avisoCorteIndice(causa: CausaErrorProveedor): string | null {
  if (esAltaDemanda(causa)) return 'alta_demanda_indice';
  if (esErrorTemporalIndice(causa)) return 'error_temporal_indice';
  return null;
}

export class AgenteKuaa {
  private readonly reloj: () => Date;

  /**
   * `perfilConocimiento` es el perfil del entorno; por omisión `produccion`. Con él, un fragmento marcado
   * `no_validado` que llegara a la recuperación se DESCARTA antes de armar el prompt (defensa en profundidad:
   * el cargador ya no debería haberlo indexado). Con `pruebas` y `versionPaquete`, además de la colección base se
   * consulta la del paquete (`coleccionPaquete`) y se mezclan por puntaje.
   */
  constructor(
    private readonly deps: DependenciasAgente,
    private readonly opciones: { perfilConocimiento?: PerfilValidacion; versionPaquete?: string | null } = {},
  ) {
    this.reloj = deps.reloj ?? (() => new Date());
  }

  async responder(crudo: EntradaKuaa, clienteId: string): Promise<ResultadoKuaa> {
    const llegada = performance.now();
    const entrada = EntradaKuaa.parse(crudo);
    const config: ConfiguracionEfectiva = resolverConfiguracion(this.deps.config, null);
    const etapa = entrada.etapa_actual;
    const claveMemoria = claveMemoriaKuaa(clienteId, entrada.oportunidad_id);
    const base: BaseBitacora = { agenteId: config.id, perfilId: config.perfilId, conversacionHash: hashConversacion(claveMemoria), canal: 'kuaa' };
    const fallback = (avisos: string[], aviso: string): ResultadoKuaa => ({ salida: salidaFallback(config, etapa), avisos: [...avisos, aviso] });

    if (!estaOperativo(config)) {
      this.deps.bitacora.registrar({ ...base, tipo: 'suspendido' });
      return { salida: { ...salidaFallback(config, etapa), texto: config.mensajes.suspendido }, avisos: ['suspendido'] };
    }

    // La entrada se normaliza antes de evaluar y de enviar al modelo.
    const texto = sanearTexto(normalizarEntradaKuaa(entrada.mensaje), config.seguridad.maxCaracteresEntrada + 1);
    if (texto.length === 0) throw new ErrorPeticion('TEXTO_VACIO', 'el mensaje está vacío');
    if (texto.length > config.seguridad.maxCaracteresEntrada) {
      this.deps.bitacora.registrar({ ...base, tipo: 'entrada_bloqueada', avisos: ['texto_largo'] });
      throw new ErrorPeticion('TEXTO_LARGO', `el mensaje supera ${config.seguridad.maxCaracteresEntrada} caracteres`);
    }

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
      } catch (e) {
        avisos.push('indice_error');
        const causa = causaDeError(e);
        this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice', causa });
        // Cuota o saturación del embebedor es una falla de infraestructura, no «no hay información»: se dice alta demanda,
        // sin llamar al modelo (sin fragmentos no hay respaldo, y RAG es obligatorio) y sin ofrecer atención humana.
        // Como el fallo del modelo en 429, el turno NO se guarda en la memoria. `tiempo` y `servidor` también son infraestructura:
        // responden `errorTemporal` con el mismo trato. Los demás fallos (autenticación, modelo, otro) siguen a `sin_respaldo`.
        const corte = avisoCorteIndice(causa);
        if (corte) return { salida: salidaFallback(config, etapa, causa), avisos: [...avisos, corte] };
      }
      if (this.opciones.perfilConocimiento === 'pruebas' && this.opciones.versionPaquete) {
        try {
          const delPaquete = await this.deps.indice.buscar(texto, { coleccion: coleccionPaquete(coleccionDe(this.deps.config, null)), topK: config.conocimiento.topK, umbral: config.conocimiento.umbral });
          fragmentos = [...fragmentos, ...delPaquete].sort((a, b) => b.puntaje - a.puntaje).slice(0, config.conocimiento.topK);
        } catch (e) {
          avisos.push('indice_error');
          const causa = causaDeError(e);
          this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice', causa });
          // Es la vía real de staging (la colección base está vacía y todo el respaldo viene del paquete). Mismo criterio si no
          // hay NADA de la base. Si la base sí aportó fragmentos, se responde con ellos (RAG cumplido, nada inventado); la
          // respuesta puede ignorar el paquete, y el aviso `indice_error` y el evento lo dejan a la vista.
          const corte = avisoCorteIndice(causa);
          if (corte && fragmentos.length === 0) return { salida: salidaFallback(config, etapa, causa), avisos: [...avisos, corte] };
        }
      }
    }

    let versionNoValidada: string | null = null;
    if (this.opciones.perfilConocimiento !== 'pruebas') {
      const habilitados = fragmentos.filter((f) => f.validacion === undefined && f.versionPaquete === undefined);
      if (habilitados.length !== fragmentos.length) avisos.push('fragmento_no_validado_descartado');
      fragmentos = habilitados;
    } else {
      const marcado = fragmentos.find((f) => f.validacion === 'no_validado');
      if (marcado) {
        versionNoValidada = marcado.versionPaquete ?? 'desconocida';
        avisos.push(`respaldo_no_validado:${versionNoValidada}`);
        this.deps.bitacora.registrar({ ...base, tipo: 'respuesta_no_validada', detalle: `paquete=${versionNoValidada}` });
      }
    }

    // De la plataforma solo la versión llega a la bitácora (validada por regex); ni el bloque ni sus textos se guardan.
    if (entrada.plataforma) avisos.push(`plataforma:${entrada.plataforma.version}`);
    const sistema = armarPromptKuaa(config, entrada, fragmentos, this.reloj(), { versionPaquete: this.opciones.perfilConocimiento === 'pruebas' ? (this.opciones.versionPaquete ?? null) : null });
    const tokens = { tokensEntrada: 0, tokensSalida: 0 };
    let textoModelo = '';
    let cortado = false;
    let motivoFin: string = 'fin';
    // Una salida que no es JSON legible («json_roto», «sin_objeto») es un fallo aleatorio del formato, no del contenido: se
    // reintenta UNA vez, y solo si la primera llamada fue rápida (el sitio corta a los 20 s). Los tokens de ambas se suman.
    // Una salida válida que contradice la base (`afirmaciones-contra-base.ts`) también se reintenta UNA vez, con la misma guarda
    // de tiempo: se agrega al mensaje de la persona una corrección fija por motivo (jamás texto del modelo ni de la base). La
    // memoria guarda siempre el mensaje original de la persona y el texto final ya corregido. Si el reintento falla, la
    // detección posterior retira la oración. `intento` cuenta todos los reintentos del turno.
    const habraRespaldo = !(config.conocimiento.modo === 'rag' && config.conocimiento.exigirRespaldo && fragmentos.length === 0 && !esCortesia(texto));
    let contenidoPersona = texto;
    let intento = 0;
    let reintentosFormato = 0;
    let reintentosContraBase = 0;
    // Primera salida válida que contradecía la base: si el reintento falla (error del proveedor, JSON roto, corte), se sigue
    // con ella y la detección posterior retira la oración; un «problema técnico» o «mucha demanda» serían falsos aquí.
    let primera: ReturnType<typeof analizarSalida> | null = null;
    let analizada: ReturnType<typeof analizarSalida>;
    for (;;) {
      try {
        const r = await this.deps.proveedor.generar({
          sistema,
          mensajes: [...historial.map((t) => ({ rol: t.rol, contenido: t.contenido })), { rol: 'usuario' as const, contenido: contenidoPersona }],
          herramientas: [],
          parametros: { modelo: config.modelo.nombre, temperatura: config.modelo.temperatura, maxTokensSalida: config.modelo.maxTokensSalida, razonamiento: config.modelo.razonamiento },
        });
        tokens.tokensEntrada += r.uso.tokensEntrada;
        tokens.tokensSalida += r.uso.tokensSalida;
        textoModelo = r.texto;
        cortado = r.motivoFin === 'max_tokens';
        motivoFin = r.motivoFin;
      } catch (e) {
        // Solo la causa enumerada llega a la bitácora y decide el texto; jamás el mensaje del error.
        const causa = causaDeError(e);
        this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'proveedor', causa, iteraciones: intento + 1, ...(intento > 0 ? tokens : {}) });
        if (primera) {
          analizada = primera;
          cortado = false;
          motivoFin = 'fin';
          avisos.push('reintento_contra_base_fallido');
          break;
        }
        return { salida: salidaFallback(config, etapa, causa), avisos: [...avisos, 'error_modelo'] };
      }
      analizada = cortado ? { causa: 'json_roto' } : analizarSalida(textoModelo);
      if (primera && (cortado || motivoFin !== 'fin' || 'causa' in analizada)) {
        analizada = primera;
        cortado = false;
        motivoFin = 'fin';
        avisos.push('reintento_contra_base_fallido');
        break;
      }
      const formatoRoto = 'causa' in analizada && (analizada.causa === 'json_roto' || analizada.causa === 'sin_objeto');
      // Solo una terminación normal: un bloqueo de seguridad del proveedor (texto vacío) es casi determinista y no se repite.
      const puedeReintentar = !cortado && motivoFin === 'fin' && intento < MAX_REINTENTOS_POR_TURNO && performance.now() - llegada <= TIEMPO_MAXIMO_PARA_REINTENTAR_MS;
      if (puedeReintentar && formatoRoto && reintentosFormato < REINTENTOS_FORMATO) {
        intento += 1;
        reintentosFormato += 1;
        avisos.push('reintento_formato');
        continue;
      }
      if (puedeReintentar && habraRespaldo && !('causa' in analizada) && reintentosContraBase < REINTENTOS_CONTRA_BASE) {
        const motivo = afirmaContraBase(sanearTexto(analizada.salida.texto, 4000));
        if (motivo) {
          intento += 1;
          reintentosContraBase += 1;
          primera = analizada;
          contenidoPersona = `${texto}\n\n${CORRECCION_POR_MOTIVO[motivo]}`;
          avisos.push(`reintento_contra_base:${motivo}`);
          continue;
        }
      }
      break;
    }

    const cierre = (r: ResultadoKuaa): ResultadoKuaa => this.cerrar(base, r, tokens, fragmentos, intento + 1);
    if (cortado) return cierre(fallback(avisos, 'respuesta_incompleta'));
    if ('causa' in analizada) return cierre(fallback([...avisos, `causa_salida:${analizada.causa}`], 'salida_invalida'));
    const interpretada = analizada.salida;
    if (analizada.descartados > 0) avisos.push('valores_descartados');

    // La salida también se sanea (controles, marcas bidi) antes de cualquier control y de la memoria.
    const sinPromesas = quitarPromesasDeEntrega(interpretada.texto);
    if (sinPromesas !== interpretada.texto.trim()) avisos.push('promesa_entrega_retirada');
    const sinRegistro = retirarNumerosDeRegistro(sinPromesas === '' ? interpretada.texto : sinPromesas);
    if (sinRegistro !== (sinPromesas === '' ? interpretada.texto : sinPromesas).trim()) avisos.push('registro_retirado');
    const conSaludo = sanearTexto(sinRegistro === '' ? interpretada.texto : sinRegistro, 4000);
    let textoBase = quitarSaludoInicial(conSaludo, texto, historial.length > 0, RESTO_MINIMO);
    const saludoQuitado = textoBase !== conSaludo;
    if (saludoQuitado) avisos.push('saludo_retirado');
    let textoSaneado = retirarCodigosInternos(textoBase);
    if (textoSaneado !== textoBase) avisos.push('codigo_interno_retirado');
    if (textoSaneado === '') return cierre(fallback([...avisos, 'causa_salida:vacia_tras_sanear'], 'salida_invalida'));
    // El detector mira el texto del modelo tal cual y también el ya limpio: el retiro nunca debe esconderle nada.
    const permitidos = permitidosDe(entrada.plataforma);
    // También se mira el texto con el saludo: quitar un prefijo nunca debe esconderle nada al detector.
    let patron = patronEnlaceOPrecio(textoBase, permitidos) ?? patronEnlaceOPrecio(textoSaneado, permitidos) ?? patronEnlaceOPrecio(conSaludo, permitidos);
    // Un valor suelto (un dominio, o «diez mil» al desmentir un precio) no justifica perder toda la respuesta: se quita
    // lo que lo lleva y se revisa de nuevo lo que queda; si aún hay algo bloqueado o queda poco, se responde sin cifras.
    if (patron) {
      const salvado = salvarQuitandoBloqueado(textoBase, (f) => patronEnlaceOPrecio(f, permitidos) !== null, RESTO_MINIMO);
      if (salvado !== null) {
        textoBase = salvado;
        textoSaneado = retirarCodigosInternos(salvado);
        patron = patronEnlaceOPrecio(textoSaneado, permitidos);
        avisos.push('frase_con_valor_retirada');
      }
    }
    if (patron) return cierre({ salida: salidaSinCifras(etapa, entrada.plataforma?.contacto.whatsapp_e164), avisos: [...avisos, `patron_bloqueado:${patron}`, 'enlace_o_precio'] });
    if (afirmaTratamientoTributario(textoBase) || afirmaTratamientoTributario(textoSaneado) || afirmaTratamientoTributario(conSaludo)) {
      return cierre({ salida: salidaTributaria(etapa), avisos: [...avisos, 'tributario_bloqueado'] });
    }
    // El nombre que se borra con el saludo («¡Hola, Su Póliza, quedó emitida…») tampoco debe esconderle un hecho al detector.
    let hecho = afirmaHechoNoRespaldado(textoSaneado, entrada.estados);
    if (hecho === null && saludoQuitado) {
      const hechoEnSaludo = afirmaHechoNoRespaldado(conSaludo, entrada.estados);
      if (hechoEnSaludo) return cierre(fallback(avisos, `hecho_no_respaldado:${hechoEnSaludo}`));
    }
    // Igual que con el dominio: se quita la frase que afirma el hecho («tu pago fue acreditado») y se revisa el resto.
    if (hecho) {
      const sinHecho = quitarFrases(textoSaneado, (f) => afirmaHechoNoRespaldado(f, entrada.estados) !== null);
      if (sinHecho.length >= RESTO_MINIMO && afirmaHechoNoRespaldado(sinHecho, entrada.estados) === null) {
        textoSaneado = sinHecho;
        hecho = null;
        avisos.push('frase_con_hecho_retirada');
      }
    }
    if (hecho) return cierre(fallback(avisos, `hecho_no_respaldado:${hecho}`));
    // Red de seguridad tras el reintento: una afirmación que contradice la base aprobada (o inventa una regla donde calla)
    // se retira con su derivación; si no queda respuesta útil, «sin respaldo» con la derivación. Nunca el «problema
    // técnico», que sería falso. A la bitácora solo van códigos.
    let reemplazoContraBase = false;
    const contraBase = afirmaContraBase(textoSaneado) ?? (saludoQuitado ? afirmaContraBase(conSaludo) : null);
    if (contraBase) {
      const { texto: resto, motivos } = quitarAfirmacionesContraBase(textoSaneado);
      for (const m of new Set([contraBase, ...motivos])) avisos.push(`contra_base:${m}`);
      if (resto.length >= RESTO_MINIMO && afirmaContraBase(resto) === null) {
        const derivacion = fraseDerivacionKuaa(config, entrada.plataforma);
        textoSaneado = resto.includes(derivacion) ? resto : `${resto} ${derivacion}`;
        avisos.push('frase_contra_base_retirada');
      } else {
        textoSaneado = textoSinRespaldo(config, entrada.plataforma);
        reemplazoContraBase = true;
        avisos.push('respuesta_contra_base_reemplazada');
      }
    }
    if (filtraPrompt(textoSaneado) || filtraPrompt(conSaludo)) return cierre(fallback(avisos, 'fuga_prompt'));

    // Sin respaldo no se afirma nada, sea cual sea la forma del texto: no hay excepción por «pregunta».
    let salida: SalidaOportunidad = { ...interpretada, texto: textoSaneado };
    if (reemplazoContraBase) salida = { ...salidaFallback(config, etapa), texto: textoSaneado, propuestas: interpretada.propuestas.filter((p) => p === 'atencion_humana_solicitada') };
    if (config.conocimiento.modo === 'rag' && config.conocimiento.exigirRespaldo && fragmentos.length === 0 && !esCortesia(texto)) {
      salida = { ...salidaFallback(config, etapa), texto: textoSinRespaldo(config, entrada.plataforma), propuestas: salida.propuestas.filter((p) => p === 'atencion_humana_solicitada') };
      avisos.push('sin_respaldo');
      this.deps.bitacora.registrar({ ...base, tipo: 'sin_respaldo' });
    }

    const marcas = extraerMarcas(salida.texto, config.seguridad.marcasPermitidas, config.seguridad.marcasLiterales);
    if (marcas.borradas > 0) avisos.push('marca_no_declarada');
    if (marcas.marcas.includes('DERIVAR')) salida = { ...salida, propuestas: [...salida.propuestas, 'atencion_humana_solicitada'] };
    const compuertas = aplicarCompuertasSalida(marcas.texto, { config });
    avisos.push(...compuertas.avisos);
    if (compuertas.avisos.length) this.deps.bitacora.registrar({ ...base, tipo: 'compuerta_salida', avisos: compuertas.avisos });
    // `afirma_cobro_real` agregaría un texto de cobro simulado ajeno a Kuaa: se cae al fallback.
    if (compuertas.avisos.includes('afirma_cobro_real')) return cierre(fallback(avisos, 'afirma_cobro_real'));
    salida = { ...salida, texto: compuertas.texto };
    if (compuertas.reemplazada || compuertas.avisos.includes('respuesta_vacia')) {
      salida = { ...salida, etapa_propuesta: etapa, objecion: null, botones: [], propuestas: [] };
    }
    salida = { ...salida, propuestas: [...new Set(salida.propuestas)].filter((p) => p !== 'seguimiento_solicitado' || entrada.permiso_seguimiento.vigente) };

    const valida = SalidaOportunidad.safeParse(salida);
    // Camino defensivo: tras el esquema y las compuertas no debería fallar; si falla, queda su causa en la bitácora.
    if (!valida.success) return cierre(fallback([...avisos, 'causa_salida:validacion_final'], 'salida_invalida'));
    const final = filtrarBotonesSalida(valida.data, entrada.estados);

    // Se guarda el JSON validado: el historial le enseña al modelo el formato que debe seguir.
    await this.deps.memoria.agregar(claveMemoria, [{ rol: 'usuario', contenido: texto }, { rol: 'asistente', contenido: JSON.stringify(final) }], config.modelo.ttlConversacionSeg);
    return cierre({ salida: final, avisos });
  }

  private cerrar(base: BaseBitacora, resultado: ResultadoKuaa, tokens: { tokensEntrada: number; tokensSalida: number }, fragmentos: FragmentoRecuperado[], iteraciones = 1): ResultadoKuaa {
    this.deps.bitacora.registrar({
      ...base,
      tipo: 'mensaje_atendido',
      iteraciones,
      ...tokens,
      avisos: [`etapa:${resultado.salida.etapa_propuesta}`, ...resultado.avisos],
      fragmentos: fragmentos.map((f) => f.id),
    });
    return resultado;
  }
}
