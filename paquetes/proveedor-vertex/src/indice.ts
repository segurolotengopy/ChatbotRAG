/**
 * ADAPTADOR VERTEX AI (Google Cloud) — Gemini + embeddings
 *
 * Único lugar del repositorio que importa `@google/genai`. Traduce el contrato
 * neutral del núcleo (`PeticionLLM` / `RespuestaLLM`) al formato de Gemini:
 *
 *   sistema            → config.systemInstruction
 *   usuario/asistente  → contents con role user/model y parts de texto
 *   asistente_herram.  → parts functionCall (el hilo de llamadas se conserva)
 *   herramienta        → parts functionResponse
 *   herramientas       → tools[0].functionDeclarations (JSON Schema subset)
 *
 * AUTENTICACIÓN: con `vertexai: true` el SDK usa Application Default Credentials
 * (la cuenta de servicio de Cloud Run, o `gcloud auth application-default login`
 * en local). NO hay API key: los secretos no viajan por la configuración. Para
 * pruebas se inyecta un cliente falso mediante `ClienteGemini`.
 *
 * MODELO: se elige por configuración (`modelo.nombre`, p. ej. `gemini-2.5-flash`).
 * Lección de NovuChat: un nombre de modelo retirado devuelve 404 «no longer
 * available»; el error se propaga como `ErrorProveedor` con el nombre incluido
 * para que el diagnóstico sea inmediato.
 *
 * TIEMPO MÁXIMO Y REINTENTO: el 2026-11-03 dos peticiones de Kuaa esperaron 58 s y 20,6 s a Vertex
 * en staging, y el sitio corta a los 20 s. Cada intento de `generar` tiene un tope de 9 000 ms
 * (`tiempoMaximoMs`). Lo transitorio se reintenta una vez (`reintentos`), sin espera: vencimiento del tiempo, estado
 * 500/502/504 y errores de red (ECONNRESET, ETIMEDOUT, EAI_AGAIN, «fetch failed»). El 503 NO es de este grupo: va con el
 * 429 (abajo), con espera y hasta 2 reintentos. Todo queda acotado por el presupuesto de 18,5 s (más abajo).
 * Un 400, 401, 403, 404 o un error desconocido sale en el primer intento; un `status`/`code` numérico no
 * transitorio decide antes que el texto del mensaje.
 *
 * EL 429 (CUOTA) Y EL 503, CRITERIO NUEVO (2026-11-05). Antes el 429 no se reintentaba «a propósito»: una cuota agotada
 * no se resuelve en 0 ms. La medición de staging (5 hilos, ~100 mensajes/min) mostró ráfagas de 4-5 fallos por segundo
 * en sesiones que en secuencia no fallaban; la HIPÓTESIS (no confirmada hasta ver `causa` en la bitácora) es que son
 * 429 por ráfaga que se liberan en segundos. Por eso el 429 (causa `cuota`) y el 503 (causa `saturacion`: el servicio
 * pide esperar) se reintentan hasta `reintentosCuota` = 2 veces, con ESPERA exponencial corta más jitter (≈400-900 ms y
 * luego ≈1 000-2 000 ms; el jitter evita que los hilos en ráfaga reintenten a la vez). SUPUESTOS NO VERIFICADOS: que un
 * 429 no se factura, y que la cuota de Gemini en Vertex es por proyecto y no por instancia (entonces el semáforo, que
 * es por instancia, no la protege del todo). Durante una limitación un turno puede hacer hasta 4 llamadas a Vertex
 * (1 + 1 transitorio + 2 por cuota, siempre dentro del presupuesto); si el supuesto de facturación fuera falso, también el costo.
 *
 * PRESUPUESTO DE LATENCIA (`presupuestoMs`, 18 500 ms = 2 × 9 s del peor caso previo más 500 ms de holgura por la
 * imprecisión de los temporizadores). Se mide desde que empieza `generar`, con la cola del semáforo incluida. TODO
 * reintento —por cuota, por saturación o transitorio— solo se hace si transcurrido + espera + `tiempoMaximoMs` ≤
 * presupuesto; si no cabe, se lanza el error. Así `generar` no pasa de ≈18,5 s en total (la cola de 3 s se descuenta del
 * reintento, no se suma). Con 429 inmediatos y sin cola caben los dos reintentos.
 *
 * TOPE DE CONCURRENCIA (semáforo por instancia y por agente): `maxConcurrentes` llamadas simultáneas al modelo (4 por
 * omisión) y espera máxima en cola `esperaMaxColaMs` (3 000 ms). En STAGING Cloud Run tiene maxScale 3 (≤ 12 simultáneas
 * en total); en PRODUCCIÓN el workflow usa `--max-instances 10` por omisión (hasta 40 en vuelo). Este paquete no cambia
 * el despliegue, y el 4 por instancia y los 3 s de cola deben medirse con la latencia real (p50 ≈ 1 s en staging) antes
 * de fijarlos en producción. Quien no obtiene cupo en 3 s falla rápido con causa `saturacion` (nunca cuelga). El cupo se
 * mantiene durante todo `generar` (reintentos y esperas incluidos: bajo limitación, soltarlo solo aumentaría la presión)
 * y se libera siempre, también ante error. RIESGO CONOCIDO (MEDIUM, compromiso a 30 días: 2026-12-05): el semáforo no es
 * por cliente, así que un cliente con clave puede dejar sin cupo a otros del mismo agente; no se implementa aquí.
 *
 * PEOR CASO DE UN TURNO DE KUAA: `generar` ≤ ≈18,5 s. El reintento de JSON roto del agente (#80) solo se hace si desde
 * la llegada pasaron ≤ 3 s, y su segunda llamada tiene hasta ≈18,5 s propios: 3 + 18,5 ≈ 21,5 s, que SÍ pasa de los
 * 20 s del sitio. Ese valor vale para la vía del reintento de JSON roto, y la búsqueda en el índice va ANTES de `generar` y
 * ahora tiene cota (≈6 s por búsqueda del embebedor; antes no la tenía), que se suma: ≈6 + 18,5 ≈ 24,5 s sin JSON roto, y
 * ≈30,5 s con perfil `pruebas` y dos búsquedas (ver `EmbebedorVertex`). El reintento de JSON roto exige un primer intento de ≈3 s con JSON roto y una segunda llamada que agote su presupuesto; es
 * improbable, pero NO se garantiza evitarlo.
 *
 * NO garantiza respuesta: si todos los intentos fallan, se lanza `ErrorProveedor` (con `causa`, sin el texto de la
 * petición) y el agente responde con su mensaje de respaldo. El texto propio del error de tiempo no incluye la
 * petición; el de Vertex se propaga tal cual. En Kuaa el mensaje NO va a la bitácora (solo la causa); el agente genérico
 * (orquestador/agente.ts) sí registra hasta 200 caracteres del mensaje: defecto previo, para otro PR. El tope vale POR
 * LLAMADA al modelo, no por turno: el agente genérico puede llamar hasta `maxIteraciones` veces (Kuaa usa una sola).
 * En el peor caso el reintento duplica las llamadas facturables. `crearClienteVertex` NO pasa `httpOptions.retryOptions`
 * a propósito: si se añadiera, el factor sería 2×5. El embebedor tiene los suyos (ver `EmbebedorVertex`).
 */
import { GoogleGenAI, type Content, type FunctionDeclaration, type GenerateContentResponse, type Part, type Schema, Type } from '@google/genai';
import type { CausaErrorProveedor, DefinicionHerramientaLLM, Embebedor, MensajeLLM, MotivoFin, PeticionLLM, ProveedorLLM, RespuestaLLM } from '@chatbotrag/nucleo';

export interface OpcionesVertex {
  proyecto: string;
  region: string;
  /** Modelo de embeddings; por defecto `text-embedding-005` (768 dimensiones). */
  modeloEmbeddings?: string;
  dimensionEmbeddings?: number;
}

/** Subconjunto del SDK que usamos; permite inyectar un falso en pruebas. */
export interface ClienteGemini {
  generateContent(peticion: {
    model: string;
    contents: Content[];
    config: { systemInstruction: string; temperature: number; maxOutputTokens: number; thinkingConfig?: { thinkingBudget: number }; tools?: Array<{ functionDeclarations: FunctionDeclaration[] }>; abortSignal?: AbortSignal };
  }): Promise<GenerateContentResponse>;
  embedContent(peticion: { model: string; contents: string[]; config?: { outputDimensionality?: number; abortSignal?: AbortSignal } }): Promise<{ embeddings?: Array<{ values?: number[] }> }>;
}

export class ErrorProveedor extends Error {
  constructor(
    mensaje: string,
    public readonly proveedor: string,
    public readonly modelo: string,
    /** Causa enumerada (la lee el núcleo con `causaDeError`). */
    public readonly causa: CausaErrorProveedor = 'otro',
  ) {
    super(mensaje);
    this.name = 'ErrorProveedor';
  }
}

export function crearClienteVertex(opciones: OpcionesVertex): ClienteGemini {
  const ai = new GoogleGenAI({ vertexai: true, project: opciones.proyecto, location: opciones.region });
  return {
    generateContent: (p) => ai.models.generateContent(p),
    embedContent: (p) => ai.models.embedContent(p),
  };
}

function aEsquema(def: DefinicionHerramientaLLM['parametros']): Schema {
  const properties: Record<string, Schema> = {};
  for (const [k, v] of Object.entries(def.properties)) {
    properties[k] = {
      type: v.type === 'number' ? Type.NUMBER : v.type === 'boolean' ? Type.BOOLEAN : Type.STRING,
      description: v.description,
      ...(v.enum ? { enum: v.enum, format: 'enum' } : {}),
    };
  }
  return { type: Type.OBJECT, properties, ...(def.required?.length ? { required: def.required } : {}) };
}

export function aContenidos(mensajes: MensajeLLM[]): Content[] {
  const contenidos: Content[] = [];
  for (const m of mensajes) {
    if (m.rol === 'usuario') contenidos.push({ role: 'user', parts: [{ text: m.contenido }] });
    else if (m.rol === 'asistente') contenidos.push({ role: 'model', parts: [{ text: m.contenido }] });
    else if (m.rol === 'asistente_herramientas') {
      const parts: Part[] = [];
      if (m.texto) parts.push({ text: m.texto });
      for (const l of m.llamadas) parts.push({ functionCall: { id: l.id, name: l.nombre, args: l.argumentos } });
      contenidos.push({ role: 'model', parts });
    } else if (m.rol === 'herramienta') {
      // functionResponse: Gemini espera un objeto; envolvemos si el resultado no lo es.
      const response = typeof m.resultado === 'object' && m.resultado !== null ? (m.resultado as Record<string, unknown>) : { resultado: m.resultado };
      const anterior = contenidos[contenidos.length - 1];
      const part: Part = { functionResponse: { id: m.idLlamada, name: m.nombre, response } };
      // Varias respuestas de herramientas consecutivas van en el mismo turno de usuario.
      if (anterior && anterior.role === 'user' && anterior.parts?.every((p) => p.functionResponse)) anterior.parts.push(part);
      else contenidos.push({ role: 'user', parts: [part] });
    }
  }
  return contenidos;
}

function motivo(fin: string | undefined, hayLlamadas: boolean): MotivoFin {
  if (hayLlamadas) return 'herramienta';
  switch (fin) {
    case 'STOP':
      return 'fin';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
      return 'seguridad';
    default:
      return fin ? 'otro' : 'fin';
  }
}

/** Opciones de la llamada al modelo (no del cliente): tiempo por intento, reintentos y límites. */
export interface OpcionesLlamadaVertex {
  tiempoMaximoMs?: number;
  /** Reintentos transitorios tras el primer intento (por omisión 1). El 503 no se desactiva con `reintentos: 0`: va por la vía de saturación (`reintentosCuota`). */
  reintentos?: number;
  /** Reintentos ante 429 y 503 (causas `cuota` y `saturacion` de la nube); por omisión 2. */
  reintentosCuota?: number;
  /** Presupuesto de latencia de `generar` para decidir un reintento por cuota; por omisión 18 500 ms. */
  presupuestoMs?: number;
  /** Llamadas simultáneas por agente y por instancia (un proveedor por configuración); por omisión 4. */
  maxConcurrentes?: number;
  /** Espera máxima por un cupo antes de fallar con causa `saturacion`; por omisión 3 000 ms. */
  esperaMaxColaMs?: number;
  /** Inyectables para pruebas: reloj en milisegundos, número en [0, 1) y espera. */
  ahora?: () => number;
  aleatorio?: () => number;
  esperar?: (ms: number) => Promise<void>;
}

class TiempoAgotado extends Error {
  constructor(public readonly ms: number) {
    super(`tiempo máximo de ${ms} ms agotado`);
    this.name = 'TiempoAgotado';
  }
}

class Saturacion extends Error {
  constructor() {
    super('demasiadas llamadas simultáneas al modelo');
    this.name = 'Saturacion';
  }
}

const ESTADOS_TRANSITORIOS = new Set([500, 502, 503, 504]);
const RED_TRANSITORIA = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i;
const TIEMPO_EN_TEXTO = /ETIMEDOUT|timed? ?out/i;
const CUOTA_EN_TEXTO = /RESOURCE_EXHAUSTED/;

/**
 * Causa enumerada de un fallo. Un `status`/`code` numérico manda sobre el texto (un 400 que cite «ETIMEDOUT» es
 * `otro`); el texto solo decide cuando no hay número. Jamás copia el mensaje: devuelve solo el enumerado.
 */
export function clasificarCausa(e: unknown): CausaErrorProveedor {
  if (e instanceof Saturacion) return 'saturacion';
  if (e instanceof TiempoAgotado) return 'tiempo';
  if (typeof e === 'object' && e !== null) {
    const { status, code } = e as { status?: unknown; code?: unknown };
    const numero = typeof status === 'number' ? status : typeof code === 'number' ? code : undefined;
    if (numero !== undefined) {
      if (numero === 429) return 'cuota';
      if (numero === 503) return 'saturacion';
      if (numero === 504) return 'tiempo';
      if (numero >= 500 && numero <= 599) return 'servidor';
      if (numero === 401 || numero === 403) return 'autenticacion';
      if (numero === 404) return 'modelo';
      return 'otro';
    }
    if (typeof code === 'string' && TIEMPO_EN_TEXTO.test(code)) return 'tiempo';
  }
  if (e instanceof Error) {
    if (CUOTA_EN_TEXTO.test(e.message)) return 'cuota';
    if (TIEMPO_EN_TEXTO.test(e.message)) return 'tiempo';
  }
  return 'otro';
}

/** Transitorio: vale la pena reintentar. Lo desconocido NO lo es. */
function esTransitorio(e: unknown): boolean {
  if (e instanceof TiempoAgotado) return true;
  if (typeof e === 'object' && e !== null) {
    const { status, code } = e as { status?: unknown; code?: unknown };
    // Un código numérico manda sobre el texto: un 400 cuyo cuerpo cite «ETIMEDOUT» no se reintenta.
    if (typeof status === 'number') return ESTADOS_TRANSITORIOS.has(status);
    if (typeof code === 'number') return ESTADOS_TRANSITORIOS.has(code);
    if (typeof code === 'string' && RED_TRANSITORIA.test(code)) return true;
  }
  return e instanceof Error && RED_TRANSITORIA.test(e.message);
}

/** Espera base y amplitud del jitter de cada reintento por cuota: ≈400-900 ms y ≈1 000-2 000 ms. */
const ESPERA_CUOTA_MS: ReadonlyArray<{ base: number; jitter: number }> = [
  { base: 400, jitter: 500 },
  { base: 1000, jitter: 1000 },
];

/**
 * Semáforo con cola FIFO y espera máxima. `adquirir` devuelve la función que libera el cupo (idempotente) o
 * rechaza con `Saturacion` al vencer la espera. Qué NO garantiza: justicia entre instancias (es por proceso).
 */
export class Semaforo {
  private libres: number;
  private readonly cola: Array<{ concedido: () => void }> = [];

  constructor(
    maximo: number,
    private readonly esperaMaxMs: number,
  ) {
    this.libres = maximo;
  }

  get enCola(): number {
    return this.cola.length;
  }

  adquirir(): Promise<() => void> {
    if (this.libres > 0) {
      this.libres -= 1;
      return Promise.resolve(this.liberador());
    }
    return new Promise((resolver, rechazar) => {
      const turno = {
        concedido: () => {
          clearTimeout(temporizador);
          resolver(this.liberador());
        },
      };
      const temporizador = setTimeout(() => {
        const i = this.cola.indexOf(turno);
        if (i >= 0) this.cola.splice(i, 1);
        rechazar(new Saturacion());
      }, this.esperaMaxMs);
      this.cola.push(turno);
    });
  }

  private liberador(): () => void {
    let liberado = false;
    return () => {
      if (liberado) return;
      liberado = true;
      const siguiente = this.cola.shift();
      if (siguiente) siguiente.concedido();
      else this.libres += 1;
    };
  }
}

export class ProveedorVertex implements ProveedorLLM {
  readonly nombre = 'vertex';
  private readonly tiempoMaximoMs: number;
  private readonly reintentos: number;
  private readonly reintentosCuota: number;
  private readonly presupuestoMs: number;
  private readonly semaforo: Semaforo;
  private readonly ahora: () => number;
  private readonly aleatorio: () => number;
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(
    private readonly cliente: ClienteGemini,
    opciones: OpcionesLlamadaVertex = {},
  ) {
    this.tiempoMaximoMs = opciones.tiempoMaximoMs ?? 9000;
    this.reintentos = opciones.reintentos ?? 1;
    this.reintentosCuota = opciones.reintentosCuota ?? ESPERA_CUOTA_MS.length;
    this.presupuestoMs = opciones.presupuestoMs ?? 18_500;
    this.ahora = opciones.ahora ?? (() => performance.now());
    this.aleatorio = opciones.aleatorio ?? Math.random;
    this.esperar = opciones.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const maxConcurrentes = opciones.maxConcurrentes ?? 4;
    const esperaMaxColaMs = opciones.esperaMaxColaMs ?? 3000;
    if (!Number.isInteger(maxConcurrentes) || maxConcurrentes < 1) throw new Error('maxConcurrentes debe ser un entero de al menos 1');
    if (!Number.isInteger(esperaMaxColaMs) || esperaMaxColaMs < 1) throw new Error('esperaMaxColaMs debe ser un entero de al menos 1 milisegundo');
    if (!Number.isInteger(this.reintentosCuota) || this.reintentosCuota < 0 || this.reintentosCuota > ESPERA_CUOTA_MS.length) throw new Error(`reintentosCuota debe ser un entero entre 0 y ${ESPERA_CUOTA_MS.length}`);
    if (!Number.isInteger(this.presupuestoMs) || this.presupuestoMs < 1) throw new Error('presupuestoMs debe ser un entero de al menos 1 milisegundo');
    this.semaforo = new Semaforo(maxConcurrentes, esperaMaxColaMs);
    if (!Number.isInteger(this.tiempoMaximoMs) || this.tiempoMaximoMs < 1) throw new Error('tiempoMaximoMs debe ser un entero de al menos 1 milisegundo');
    if (!Number.isInteger(this.reintentos) || this.reintentos < 0) throw new Error('reintentos debe ser un entero mayor o igual a 0');
  }

  /** Un intento con su propio AbortController y temporizador; el temporizador se limpia siempre. */
  private async intentar(p: Parameters<ClienteGemini['generateContent']>[0]): Promise<GenerateContentResponse> {
    const control = new AbortController();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const vencimiento = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(() => {
        // Primero el rechazo: si el cliente respeta la señal y rechaza con AbortError, gana el vencimiento.
        rechazar(new TiempoAgotado(this.tiempoMaximoMs));
        control.abort();
      }, this.tiempoMaximoMs);
    });
    try {
      const llamada = this.cliente.generateContent({ ...p, config: { ...p.config, abortSignal: control.signal } });
      // Si gana el temporizador, la llamada abortada puede rechazar después: se silencia para no dejar un rechazo sin atender.
      llamada.catch(() => undefined);
      return await Promise.race([llamada, vencimiento]);
    } finally {
      clearTimeout(temporizador);
    }
  }

  async generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
    const modelo = peticion.parametros.modelo;
    const solicitud: Parameters<ClienteGemini['generateContent']>[0] = {
      model: modelo,
      contents: aContenidos(peticion.mensajes),
      config: {
        systemInstruction: peticion.sistema,
        temperature: peticion.parametros.temperatura,
        maxOutputTokens: peticion.parametros.maxTokensSalida,
        // Con `desactivado`, presupuesto 0: el razonamiento no consume el tope de salida. Con `automatico`
        // no se envía nada y el modelo decide, como siempre. Gemini 2.5 Pro no admite 0 (el servicio lo rechaza).
        ...(peticion.parametros.razonamiento === 'desactivado' ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        ...(peticion.herramientas.length
          ? { tools: [{ functionDeclarations: peticion.herramientas.map((h) => ({ name: h.nombre, description: h.descripcion, parameters: aEsquema(h.parametros) })) }] }
          : {}),
      },
    };
    const inicio = this.ahora();
    let liberar: () => void;
    try {
      liberar = await this.semaforo.adquirir();
    } catch (e) {
      throw new ErrorProveedor(`Vertex (${modelo}): ${e instanceof Error ? e.message : String(e)}`, 'vertex', modelo, clasificarCausa(e));
    }
    let r: GenerateContentResponse | undefined;
    try {
      let transitorios = 0;
      let porCuota = 0;
      for (;;) {
        try {
          r = await this.intentar(solicitud);
          break;
        } catch (e) {
          const causa = clasificarCausa(e);
          // Todo reintento exige que el siguiente intento, en su peor caso, quepa en el presupuesto medido desde `inicio`.
          const cabe = (espera: number): boolean => this.ahora() - inicio + espera + this.tiempoMaximoMs <= this.presupuestoMs;
          if (causa === 'cuota' || causa === 'saturacion') {
            if (porCuota < this.reintentosCuota) {
              const { base, jitter } = ESPERA_CUOTA_MS[porCuota]!;
              const espera = Math.round(base + this.aleatorio() * jitter);
              if (cabe(espera)) {
                porCuota += 1;
                await this.esperar(espera);
                continue;
              }
            }
          } else if (transitorios < this.reintentos && esTransitorio(e) && cabe(0)) {
            transitorios += 1;
            continue;
          }
          throw new ErrorProveedor(`Vertex (${modelo}): ${e instanceof Error ? e.message : String(e)}`, 'vertex', modelo, causa);
        }
      }
    } finally {
      liberar();
    }
    const candidato = r.candidates?.[0];
    const partes = candidato?.content?.parts ?? [];
    const texto = partes.map((p) => p.text ?? '').join('').trim();
    const llamadas = partes
      .filter((p) => p.functionCall)
      .map((p, i) => ({
        id: p.functionCall!.id ?? `vx-${i + 1}`,
        nombre: p.functionCall!.name ?? '',
        argumentos: (p.functionCall!.args ?? {}) as Record<string, unknown>,
      }))
      .filter((l) => l.nombre);
    return {
      texto,
      llamadasHerramienta: llamadas,
      motivoFin: motivo(candidato?.finishReason as string | undefined, llamadas.length > 0),
      uso: { tokensEntrada: r.usageMetadata?.promptTokenCount ?? 0, tokensSalida: (r.usageMetadata?.candidatesTokenCount ?? 0) + (r.usageMetadata?.thoughtsTokenCount ?? 0) },
    };
  }
}

/** Opciones de las llamadas de embeddings (no del cliente): consulta de un turno e indexación, cada una con sus topes. */
export interface OpcionesEmbebedorVertex {
  modelo?: string;
  dimension?: number;
  /** CONSULTA. Tope de cada intento; por omisión 4 000 ms. Vencido, falla con causa `tiempo` (no se reintenta). */
  tiempoMaximoMs?: number;
  /** CONSULTA. Reintentos ante 429 y 503 (causas `cuota` y `saturacion`); por omisión 1 (espera ≈400-900 ms). */
  reintentosCuota?: number;
  /** CONSULTA. Presupuesto de cada llamada (un lote), cola incluida; por omisión 6 000 ms. */
  presupuestoMs?: number;
  /** INDEXACIÓN. Tope de cada intento (lotes de hasta 20 000 caracteres); por omisión 30 000 ms. Sin reintento por tiempo. */
  tiempoMaximoIndexacionMs?: number;
  /** INDEXACIÓN. Reintentos ante 429 y 503; por omisión 2. */
  reintentosCuotaIndexacion?: number;
  /** INDEXACIÓN. Presupuesto por lote; por omisión 40 000 ms. */
  presupuestoIndexacionMs?: number;
  /** Solo CONSULTA: llamadas simultáneas por agente y por instancia; por omisión 4. */
  maxConcurrentes?: number;
  /** Solo CONSULTA: espera máxima por un cupo antes de fallar con causa `saturacion`; por omisión 2 000 ms. */
  esperaMaxColaMs?: number;
  /** Inyectables para pruebas: reloj en milisegundos, número en [0, 1) y espera. */
  ahora?: () => number;
  aleatorio?: () => number;
  esperar?: (ms: number) => Promise<void>;
}

/** Topes de una llamada de embeddings; la consulta y la indexación usan perfiles distintos. */
interface PerfilLlamada {
  tiempoMaximoMs: number;
  reintentosCuota: number;
  presupuestoMs: number;
  /** La indexación es en serie y fuera del tráfico: no usa el semáforo de las consultas. */
  conSemaforo: boolean;
}

/**
 * EMBEBEDOR VERTEX — tope, reintento y semáforo propios (2026-11-06; ajustado tras la revisión).
 *
 * ORIGEN: en la prueba de staging (rev 00066, 5 hilos × 47 críticas = 265 respuestas) la API de embeddings devolvió 429
 * cuatro veces; el agente lo trató como «sin información» (`sin_respaldo`) aunque era una falla de infraestructura, y la
 * llamada no tenía cota de tiempo. El modelo de lenguaje no falló gracias al reintento de `ProveedorVertex`; aquí se aplica
 * el mismo patrón, con valores propios, porque la búsqueda va ANTES de `generar` y suma a la latencia del turno.
 *
 * AJUSTE DEL 2026-11-07: el tope de 2,5 s del #94 cortó llamadas lentas que antes terminaban bien (2 de 541 mensajes en la corrida
 * de staging, rev 00071, causa `tiempo`, ≈0,37 %), y el agente las tomó por «sin información». Se sube a 4 s por intento y 6 s de
 * presupuesto. SUPUESTO NO VERIFICADO: que 4 s alcance para la cola de latencia; hay que medirlo. Empeora el peor caso del turno
 * (arriba) y NO está garantizado: queda por encima de los 20 s del sitio.
 *
 * DOS PERFILES, porque consultar e indexar no se parecen:
 *  - CONSULTA (`embeber`, la usa `buscar` en cada turno; un texto): tope de 4 s por intento (`AbortController`; vencido,
 *    causa `tiempo`, sin reintento), hasta 1 reintento del 429 y el 503 con espera ≈400-900 ms (jitter), solo si
 *    transcurrido + espera + 4 s ≤ presupuesto de 6 s por llamada (cola incluida), y semáforo de 4 simultáneas con cola
 *    de 2 s (agotada, falla rápido con causa `saturacion`).
 *  - INDEXACIÓN (`embeberParaIndexar`, la usan `indexar` del índice al cargar el corpus y el paquete; lotes de hasta 100
 *    textos y 20 000 caracteres, ~25 lotes en total): tope de 30 s por intento, SIN reintento por tiempo, hasta 2 reintentos
 *    del 429 y el 503 dentro de 40 s por lote, y sin semáforo (es en serie y no compite con el tráfico). Con el tope corto de
 *    la consulta, un lote grande vencería y tumbaría `cargarCorpus` o dejaría `paquete_no_cargado`. SUPUESTO NO VERIFICADO:
 *    no se midió la latencia real de un lote de 20 000 caracteres; los 30 s son un margen razonado, no un dato.
 * El lote se reintenta ENTERO, sin partirlo ni repetir lotes ya resueltos; cada lote tiene su propio presupuesto.
 * Un 400/401/403/404 o un error desconocido salen en el primer intento.
 *
 * PEOR CASO DE LA BÚSQUEDA DE UN TURNO: ≈6 s por búsqueda (más la imprecisión de los temporizadores); antes no tenía cota.
 * Sumado a `generar` (≈18,5 s) queda ≈24,5 s con UNA búsqueda, que ya pasa de los 20 s del sitio. Con perfil `pruebas`
 * y las dos colecciones con vectores hay DOS búsquedas, en serie: ≈12 s + 18,5 s ≈ 30,5 s. Ambos son peores casos
 * (todo agota su tope), no lo habitual (p50 de la búsqueda ≈ cientos de ms, sin medir aquí); NO se garantiza evitarlos.
 * Solo el índice EN MEMORIA, con la colección base vacía (`fuentes: []` en Kuaa), no llama al embebedor: en staging hoy solo
 * hay la búsqueda del paquete. pgvector embebe SIEMPRE la consulta: con perfil `pruebas` son dos búsquedas aunque la base esté
 * vacía, y el peor caso es ≈30,5 s.
 *
 * SEMÁFORO: es por agente Y por instancia (armar-agentes.ts crea un EmbebedorVertex por configuración), no por proceso ni
 * por proyecto. SUPUESTOS NO VERIFICADOS: que la cuota de embeddings sea por proyecto (entonces ni este semáforo ni el del
 * modelo la protegen del todo), que un 429 no se facture, y que 4 simultáneas, 2 s de cola y 6 s de presupuesto sean los
 * valores correctos: deben medirse en staging. NO garantiza que la cuota se libere en esos segundos: si no, el agente
 * responde con la frase de alta demanda. Y si solo falla el paquete y la base aportó fragmentos, la respuesta se arma solo
 * con la base y puede ser poco pertinente (el agente lo deja en `indice_error`, no lo corrige).
 *
 * VÍA DE INDEXACIÓN Y ENVOLTORIOS: `embeberParaIndexar` es opcional en el puerto. `EmbebedorConMemoria` (banco) la delega en
 * el interno sin memoria: H4d envuelve el embebedor con memoria y se lo pasa al índice, y sin esa delegación `indexar` caería
 * en `embeber` y heredaría los topes cortos de la consulta. También la usan `prepararIndiceSemantico` y el script de medición.
 *
 * ARRANQUE (H4d, rama aparte, no integrada aquí): `prepararSemanticaConReintento` reintenta tras 2 s ante cuota y el embebedor
 * ya agota su presupuesto de consulta, así que el reintento del arranque se suma a los suyos; además `conTiempoLimite` del
 * arranque NO cancela: al vencer su tope de 10 s el `embeber` sigue en segundo plano ocupando cupos del semáforo y
 * llamadas a Vertex. Hay que coordinarlo al integrar H4d (p. ej. pasar una señal de cancelación o usar la vía de indexación).
 *
 * MENSAJE DEL ERROR: `ErrorProveedor.message` incluye el mensaje del SDK, que podría citar texto de la petición en un 400
 * (SOSPECHA NO VERIFICADA). Los consumidores deben registrar solo `causa`, como hace Kuaa. `CUOTA_EN_TEXTO`
 * (RESOURCE_EXHAUSTED) solo decide cuando el error del SDK no trae `status` ni `code` numéricos: el número manda siempre.
 */
export class EmbebedorVertex implements Embebedor {
  /** `vertex-embeddings:<modelo>`: el modelo forma parte del nombre, y con él la calibración del banco (H4b). */
  readonly nombre: string;
  readonly dimension: number;
  private readonly modelo: string;
  private readonly consulta: PerfilLlamada;
  private readonly indexacion: PerfilLlamada;
  private readonly semaforo: Semaforo;
  private readonly ahora: () => number;
  private readonly aleatorio: () => number;
  private readonly esperar: (ms: number) => Promise<void>;

  constructor(
    private readonly cliente: ClienteGemini,
    opciones: OpcionesEmbebedorVertex = {},
  ) {
    this.modelo = opciones.modelo ?? 'text-embedding-005';
    this.nombre = `vertex-embeddings:${this.modelo}`;
    this.dimension = opciones.dimension ?? 768;
    this.consulta = { tiempoMaximoMs: opciones.tiempoMaximoMs ?? 4000, reintentosCuota: opciones.reintentosCuota ?? 1, presupuestoMs: opciones.presupuestoMs ?? 6000, conSemaforo: true };
    this.indexacion = { tiempoMaximoMs: opciones.tiempoMaximoIndexacionMs ?? 30_000, reintentosCuota: opciones.reintentosCuotaIndexacion ?? 2, presupuestoMs: opciones.presupuestoIndexacionMs ?? 40_000, conSemaforo: false };
    this.ahora = opciones.ahora ?? (() => performance.now());
    this.aleatorio = opciones.aleatorio ?? Math.random;
    this.esperar = opciones.esperar ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    const maxConcurrentes = opciones.maxConcurrentes ?? 4;
    const esperaMaxColaMs = opciones.esperaMaxColaMs ?? 2000;
    if (!Number.isInteger(maxConcurrentes) || maxConcurrentes < 1) throw new Error('maxConcurrentes debe ser un entero de al menos 1');
    if (!Number.isInteger(esperaMaxColaMs) || esperaMaxColaMs < 1) throw new Error('esperaMaxColaMs debe ser un entero de al menos 1 milisegundo');
    for (const [etiqueta, perfil] of [['', this.consulta], ['Indexacion', this.indexacion]] as const) {
      if (!Number.isInteger(perfil.reintentosCuota) || perfil.reintentosCuota < 0 || perfil.reintentosCuota > ESPERA_CUOTA_MS.length) throw new Error(`reintentosCuota${etiqueta} debe ser un entero entre 0 y ${ESPERA_CUOTA_MS.length}`);
      if (!Number.isInteger(perfil.presupuestoMs) || perfil.presupuestoMs < 1) throw new Error(`presupuesto${etiqueta}Ms debe ser un entero de al menos 1 milisegundo`);
      if (!Number.isInteger(perfil.tiempoMaximoMs) || perfil.tiempoMaximoMs < 1) throw new Error(`tiempoMaximo${etiqueta}Ms debe ser un entero de al menos 1 milisegundo`);
    }
    this.semaforo = new Semaforo(maxConcurrentes, esperaMaxColaMs);
  }

  /** Un intento con su propio AbortController y temporizador; el temporizador se limpia siempre. */
  private async intentar(lote: string[], tiempoMaximoMs: number): Promise<{ embeddings?: Array<{ values?: number[] }> }> {
    const control = new AbortController();
    let temporizador: ReturnType<typeof setTimeout> | undefined;
    const vencimiento = new Promise<never>((_, rechazar) => {
      temporizador = setTimeout(() => {
        rechazar(new TiempoAgotado(tiempoMaximoMs));
        control.abort();
      }, tiempoMaximoMs);
    });
    try {
      const llamada = this.cliente.embedContent({ model: this.modelo, contents: lote, config: { outputDimensionality: this.dimension, abortSignal: control.signal } });
      llamada.catch(() => undefined);
      return await Promise.race([llamada, vencimiento]);
    } finally {
      clearTimeout(temporizador);
    }
  }

  private fallo(e: unknown, causa: CausaErrorProveedor): ErrorProveedor {
    return new ErrorProveedor(`Vertex embeddings (${this.modelo}): ${e instanceof Error ? e.message : String(e)}`, 'vertex', this.modelo, causa);
  }

  /** Una llamada de embeddings (un lote entero) con cola, reintento por cuota y presupuesto. */
  private async llamarLote(lote: string[], perfil: PerfilLlamada): Promise<{ embeddings?: Array<{ values?: number[] }> }> {
    const inicio = this.ahora();
    let liberar: () => void = () => undefined;
    if (perfil.conSemaforo) {
      try {
        liberar = await this.semaforo.adquirir();
      } catch (e) {
        throw this.fallo(e, clasificarCausa(e));
      }
    }
    try {
      let porCuota = 0;
      for (;;) {
        try {
          return await this.intentar(lote, perfil.tiempoMaximoMs);
        } catch (e) {
          const causa = clasificarCausa(e);
          if ((causa === 'cuota' || causa === 'saturacion') && porCuota < perfil.reintentosCuota) {
            const { base, jitter } = ESPERA_CUOTA_MS[porCuota]!;
            const espera = Math.round(base + this.aleatorio() * jitter);
            if (this.ahora() - inicio + espera + perfil.tiempoMaximoMs <= perfil.presupuestoMs) {
              porCuota += 1;
              await this.esperar(espera);
              continue;
            }
          }
          throw this.fallo(e, causa);
        }
      }
    } finally {
      liberar();
    }
  }

  private async embeberCon(textos: string[], perfil: PerfilLlamada): Promise<number[][]> {
    if (textos.length === 0) return [];
    const salida: number[][] = [];
    for (const lote of agruparPorPresupuesto(textos)) {
      const r = await this.llamarLote(lote, perfil);
      const vectores = r.embeddings ?? [];
      if (vectores.length !== lote.length) throw new ErrorProveedor(`Vertex embeddings devolvió ${vectores.length} vectores para ${lote.length} textos`, 'vertex', this.modelo);
      for (const v of vectores) salida.push(v.values ?? []);
    }
    return salida;
  }

  /** Vía de CONSULTA (tope corto). */
  embeber(textos: string[]): Promise<number[][]> {
    return this.embeberCon(textos, this.consulta);
  }

  /** Vía de INDEXACIÓN (tope largo, sin semáforo): la usa `indexar` del índice, no los turnos. */
  embeberParaIndexar(textos: string[]): Promise<number[][]> {
    return this.embeberCon(textos, this.indexacion);
  }
}

/** Textos por petición: el servicio admite hasta 250; se queda corto a propósito. */
export const MAX_TEXTOS_POR_LOTE = 100;
/**
 * Caracteres por petición. El modelo rechaza una petición de más de 20 000 tokens en total (no por texto):
 * el 2026-10-31 un lote de 100 fragmentos de ~900 caracteres midió 31 145 y la carga del paquete de Kuaa
 * falló. Con 20 000 caracteres, incluso a 1,5 caracteres por token (peor caso, texto con números y
 * símbolos) quedan ~13 300 tokens, bajo el tope. No garantiza el tope para un texto suelto más largo que
 * el presupuesto: ese viaja solo y el servicio decide.
 */
export const MAX_CARACTERES_POR_LOTE = 20_000;

export function agruparPorPresupuesto(textos: string[]): string[][] {
  const lotes: string[][] = [];
  let actual: string[] = [];
  let caracteres = 0;
  for (const t of textos) {
    if (actual.length > 0 && (actual.length >= MAX_TEXTOS_POR_LOTE || caracteres + t.length > MAX_CARACTERES_POR_LOTE)) {
      lotes.push(actual);
      actual = [];
      caracteres = 0;
    }
    actual.push(t);
    caracteres += t.length;
  }
  if (actual.length > 0) lotes.push(actual);
  return lotes;
}
