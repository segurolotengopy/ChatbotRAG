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
 * botones y propuestas vacíos; jamás el texto crudo del modelo. `continuar_pago` solo sobrevive si SLT
 * informó `solicitud: completada`. La entrada se normaliza ANTES de las compuertas (invisibles, marcas
 * combinantes, homóglifos) y el modelo recibe el texto normalizado.
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
import { mensajeSinRespaldo } from '../prompt/armar.js';
import type { EventoBitacora } from '../puertos/bitacora.js';
import type { FragmentoRecuperado } from '../puertos/indice-conocimiento.js';
import { EntradaKuaa, SalidaOportunidad, filtrarBotonesSalida } from './esquemas.js';
import { normalizarEntradaKuaa } from './normalizar-entrada.js';
import { armarPromptKuaa } from './prompt-kuaa.js';
import { afirmaHechoNoRespaldado, contieneEnlaceOPrecio, filtraPrompt, interpretarSalidaModelo, salidaFallback } from './salida-kuaa.js';

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
      } catch {
        avisos.push('indice_error');
        this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice' });
      }
      if (this.opciones.perfilConocimiento === 'pruebas' && this.opciones.versionPaquete) {
        try {
          const delPaquete = await this.deps.indice.buscar(texto, { coleccion: coleccionPaquete(coleccionDe(this.deps.config, null)), topK: config.conocimiento.topK, umbral: config.conocimiento.umbral });
          fragmentos = [...fragmentos, ...delPaquete].sort((a, b) => b.puntaje - a.puntaje).slice(0, config.conocimiento.topK);
        } catch {
          avisos.push('indice_error');
          this.deps.bitacora.registrar({ ...base, tipo: 'error_modelo', codigo: 'indice' });
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

    const sistema = armarPromptKuaa(config, entrada, fragmentos, this.reloj(), { versionPaquete: this.opciones.perfilConocimiento === 'pruebas' ? (this.opciones.versionPaquete ?? null) : null });
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

    const cierre = (r: ResultadoKuaa): ResultadoKuaa => this.cerrar(base, r, tokens, fragmentos);
    if (cortado) return cierre(fallback(avisos, 'respuesta_incompleta'));
    const interpretada = interpretarSalidaModelo(textoModelo);
    if (!interpretada) return cierre(fallback(avisos, 'salida_invalida'));

    // La salida también se sanea (controles, marcas bidi) antes de cualquier control y de la memoria.
    const textoSaneado = sanearTexto(interpretada.texto, 4000);
    if (textoSaneado === '') return cierre(fallback(avisos, 'salida_invalida'));
    if (contieneEnlaceOPrecio(textoSaneado)) return cierre(fallback(avisos, 'enlace_o_precio'));
    const hecho = afirmaHechoNoRespaldado(textoSaneado, entrada.estados);
    if (hecho) return cierre(fallback(avisos, `hecho_no_respaldado:${hecho}`));
    if (filtraPrompt(textoSaneado)) return cierre(fallback(avisos, 'fuga_prompt'));

    // Sin respaldo no se afirma nada, sea cual sea la forma del texto: no hay excepción por «pregunta».
    let salida: SalidaOportunidad = { ...interpretada, texto: textoSaneado };
    if (config.conocimiento.modo === 'rag' && config.conocimiento.exigirRespaldo && fragmentos.length === 0 && !esCortesia(texto)) {
      salida = { ...salidaFallback(config, etapa), texto: mensajeSinRespaldo(config), propuestas: salida.propuestas.filter((p) => p === 'atencion_humana_solicitada') };
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
    if (!valida.success) return cierre(fallback(avisos, 'salida_invalida'));
    const final = filtrarBotonesSalida(valida.data, entrada.estados);

    // Se guarda el JSON validado: el historial le enseña al modelo el formato que debe seguir.
    await this.deps.memoria.agregar(claveMemoria, [{ rol: 'usuario', contenido: texto }, { rol: 'asistente', contenido: JSON.stringify(final) }], config.modelo.ttlConversacionSeg);
    return cierre({ salida: final, avisos });
  }

  private cerrar(base: BaseBitacora, resultado: ResultadoKuaa, tokens: { tokensEntrada: number; tokensSalida: number }, fragmentos: FragmentoRecuperado[]): ResultadoKuaa {
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
