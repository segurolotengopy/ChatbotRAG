/**
 * =============================================================================
 * ESQUEMA DE CONFIGURACIÓN DEL AGENTE
 * =============================================================================
 *
 * Este archivo es el contrato entre el panel de configuración, el servicio y el
 * núcleo. Todo lo que un cliente puede cambiar de un agente está acá; lo que no
 * está acá **no es configurable** y vive en código (el prompt base, las frases de
 * los enumerados, los patrones de las compuertas).
 *
 * TRES DECISIONES QUE ORDENAN EL ESQUEMA
 * --------------------------------------
 * 1. LO QUE DETERMINA COMPORTAMIENTO ES ENUMERADO. `voz.tratamiento`, `voz.emojis`,
 *    `voz.longitud`… son listas cerradas. El valor selecciona una frase escrita por
 *    nosotros (ver `prompt/frases.ts`); nunca se interpola en el prompt. Convertir
 *    texto libre en enumerado es la defensa más fuerte contra la inyección de
 *    prompt, porque elimina el texto en vez de limpiarlo.
 *
 * 2. EL TEXTO LIBRE TIENE TOPE Y VA EN `datos`. Dirección, políticas, instrucciones
 *    extra: todo con `max()` y todo dentro de una sección que el armador del
 *    prompt rotula como DATO y delimita. Nunca por delante de las reglas.
 *
 * 3. LOS CAMPOS DERIVADOS NO EXISTEN EN EL ESQUEMA. No hay `horarioLegible` ni
 *    `estaOperativo` ni `datosFaltantes`: se calculan en `derivados.ts`. Si
 *    existieran, alguien podría fijarlos y separarlos de la verdad.
 *
 * Los perfiles (`perfiles.<id>`) son superposiciones parciales de la base; un
 * perfil NO puede cambiar `id`, `version` ni `modelo` (eso es del operador del
 * servicio, no del contenido).
 */
import { z } from 'zod';

/** Identificadores: minúsculas, dígitos y guiones. Se usan en rutas y nombres de colección. */
export const ID_AGENTE = /^[a-z0-9][a-z0-9-]{2,59}$/;
export const ID_PERFIL = /^[A-Za-z0-9][A-Za-z0-9_-]{1,59}$/;

const textoCorto = (max: number) => z.string().trim().max(max);
const textoOpcional = (max: number) => z.string().trim().max(max).optional();

export const TRATAMIENTOS = ['usted', 'tu', 'vos', 'neutro'] as const;
export const EMOJIS = ['ninguno', 'pocos', 'muchos'] as const;
export const LONGITUDES = ['breve', 'media', 'amplia'] as const;
export const REGISTROS = ['formal', 'cercano'] as const;
export const ESTADOS_OPERACION = ['operativo', 'suspendido'] as const;
export const DIAS = ['lun', 'mar', 'mie', 'jue', 'vie', 'sab', 'dom'] as const;

/** Categorías de entrada que el núcleo sabe detectar y bloquear antes del LLM. */
export const CATEGORIAS_ENTRADA = ['cedula', 'tarjeta', 'salud', 'pep', 'otp', 'clave', 'inyeccion'] as const;
/** Compuertas de salida disponibles. Cada una es una función en `compuertas/salida.ts`. */
export const COMPUERTAS_SALIDA = [
  'niega_ia',
  'promesa_indemnizacion',
  'decision_elegibilidad',
  'dato_confidencial',
  'marca_no_declarada',
  'afirma_cobro_real',
] as const;

export const esquemaVoz = z
  .object({
    tratamiento: z.enum(TRATAMIENTOS).default('usted'),
    emojis: z.enum(EMOJIS).default('pocos'),
    longitud: z.enum(LONGITUDES).default('breve'),
    registro: z.enum(REGISTROS).default('formal'),
  })
  .strict();

export const esquemaHorarios = z
  .object(Object.fromEntries(DIAS.map((d) => [d, z.string().regex(/^(\d{2}:\d{2}-\d{2}:\d{2}|cerrado)$/i).optional()])))
  .strict();

export const esquemaContactoHumano = z
  .object({
    whatsapp: z.string().regex(/^[0-9]{8,15}$/).optional(),
    correo: z.string().email().max(254).optional(),
    telefono: z.string().regex(/^[0-9+ ()-]{6,24}$/).optional(),
    /** Texto que el asistente muestra al derivar. Se rotula como DATO. */
    texto: textoOpcional(300),
  })
  .strict();

export const esquemaOperacion = z
  .object({
    estado: z.enum(ESTADOS_OPERACION).default('operativo'),
    horarios: esquemaHorarios.prefault({}),
    /** Prefijos telefónicos aceptados (canal WhatsApp). Vacío = cualquier origen. */
    prefijosPermitidos: z.array(z.string().regex(/^[0-9]{1,4}$/)).max(10).default([]),
    contactoHumano: esquemaContactoHumano.prefault({}),
  })
  .strict();

export const esquemaDatos = z
  .object({
    direccion: textoOpcional(200),
    /** Políticas del negocio en texto libre, rotuladas por clave. */
    politicas: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{1,40}$/), textoCorto(600)).prefault({}),
    /** Datos que el negocio declara NO tener. Se suman a los calculados por campos vacíos. */
    datosQueNoTenemos: z.array(textoCorto(80)).max(20).default([]),
    /** Hechos adicionales que el asistente puede afirmar. Cada uno es un DATO, no una regla. */
    hechos: z.array(textoCorto(300)).max(40).default([]),
    instruccionesExtra: textoOpcional(1500),
  })
  .strict();

export const esquemaAlcance = z
  .object({
    temasPermitidos: z.array(textoCorto(120)).max(40).default([]),
    temasBloqueados: z.array(textoCorto(120)).max(40).default([]),
    /** Acciones que el asistente debe declarar que NO puede realizar. */
    accionesProhibidas: z.array(textoCorto(160)).max(30).default([]),
  })
  .strict();

export const esquemaFuente = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),
    titulo: textoCorto(160),
    version: textoCorto(40),
    visibilidad: z.enum(['publico', 'interno']).default('publico'),
    /** Ruta relativa al directorio de corpus (Markdown o texto plano). */
    ruta: z.string().regex(/^[A-Za-z0-9_./-]+$/).refine((r) => !r.includes('..'), 'sin ..'),
  })
  .strict();

export const esquemaConocimiento = z
  .object({
    modo: z.enum(['rag', 'solo_prompt']).default('rag'),
    coleccion: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/).optional(),
    topK: z.number().int().min(1).max(20).default(5),
    umbral: z.number().min(0).max(1).default(0.35),
    /** Con true, sin fragmentos por encima del umbral no hay afirmación: se deriva. */
    exigirRespaldo: z.boolean().default(true),
    tamanoFragmento: z.number().int().min(200).max(4000).default(900),
    solapamiento: z.number().int().min(0).max(1000).default(120),
    fuentes: z.array(esquemaFuente).max(200).default([]),
  })
  .strict();

export const esquemaSeguridad = z
  .object({
    bloquearEntrada: z.array(z.enum(CATEGORIAS_ENTRADA)).default(['cedula', 'tarjeta', 'otp', 'clave', 'inyeccion']),
    compuertasSalida: z.array(z.enum(COMPUERTAS_SALIDA)).default(['niega_ia', 'dato_confidencial', 'marca_no_declarada']),
    /** Términos que jamás deben aparecer en una respuesta (nombres internos, márgenes…). */
    terminosConfidenciales: z.array(textoCorto(80)).max(100).default([]),
    maxCaracteresEntrada: z.number().int().min(50).max(8000).default(2000),
    /** Marcas de control `[MARCA]` que el modelo puede emitir. Cualquier otra se borra. */
    marcasPermitidas: z.array(z.string().regex(/^[A-Z_]{3,30}$/)).max(10).default(['DERIVAR']),
  })
  .strict();

export const esquemaParametroHerramienta = z
  .object({
    tipo: z.enum(['string', 'number', 'boolean']),
    descripcion: textoCorto(300),
    opciones: z.array(textoCorto(80)).max(50).optional(),
    requerido: z.boolean().default(false),
  })
  .strict();

export const esquemaHerramienta = z
  .object({
    nombre: z.string().regex(/^[a-z][a-z0-9_]{2,40}$/),
    descripcion: textoCorto(400),
    parametros: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,40}$/), esquemaParametroHerramienta).prefault({}),
    /**
     * `interna`: la resuelve el núcleo (derivar_humano, recomendar_opcion, consultar_horarios).
     * `http`: la resuelve el servicio llamando a `url` (POST JSON) con la firma configurada.
     */
    tipo: z.enum(['interna', 'http']).default('interna'),
    url: z.string().url().startsWith('https://').optional(),
    /** Tope de llamadas por turno. La economía de herramientas se impone en código. */
    maxPorTurno: z.number().int().min(1).max(3).default(1),
  })
  .strict()
  .refine((h) => h.tipo !== 'http' || Boolean(h.url), { message: 'Una herramienta http necesita url' });

export const esquemaFaceta = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,40}$/),
    pregunta: textoCorto(200),
    opciones: z.array(textoCorto(80)).min(2).max(12),
    /** Facetas sensibles NO se permiten: el validador rechaza ids/preguntas de salud, PEP, etc. */
  })
  .strict();

export const esquemaReglaOrientacion = z
  .object({
    si: z.record(z.string(), z.string()),
    recomendar: textoCorto(80),
    texto: textoCorto(600),
  })
  .strict();

export const esquemaOrientacion = z
  .object({
    /** Preguntas que el asistente puede hacer para orientar, sin pedir datos sensibles. */
    facetas: z.array(esquemaFaceta).max(8).default([]),
    /** Reglas deterministas: con estas facetas, esta recomendación. El modelo no inventa. */
    reglas: z.array(esquemaReglaOrientacion).max(60).default([]),
    /** Texto que acompaña siempre a una recomendación (p. ej. «es orientación, no una oferta»). */
    aclaracion: textoOpcional(400),
  })
  .strict();

export const esquemaMensajes = z
  .object({
    bienvenida: textoCorto(600),
    errorTemporal: textoCorto(300),
    fueraDeAlcance: textoCorto(400),
    sinRespaldo: textoCorto(400),
    derivacion: textoCorto(400),
    entradaBloqueada: textoCorto(400),
    suspendido: textoCorto(300),
    cierre: textoOpcional(300),
  })
  .strict();

export const esquemaModelo = z
  .object({
    proveedor: z.enum(['vertex', 'bedrock', 'simulado']),
    nombre: textoCorto(120),
    modeloEmbeddings: textoOpcional(120),
    temperatura: z.number().min(0).max(1).default(0.3),
    maxTokensSalida: z.number().int().min(64).max(8192).default(1024),
    maxIteraciones: z.number().int().min(1).max(6).default(3),
    ventanaMemoria: z.number().int().min(2).max(40).default(10),
    /** Segundos de inactividad tras los cuales la conversación se olvida. */
    ttlConversacionSeg: z.number().int().min(60).max(86400).default(3600),
  })
  .strict();

export const esquemaIdentidad = z
  .object({
    nombreAsistente: textoCorto(60),
    organizacion: textoCorto(120),
    descripcion: textoOpcional(400),
    idioma: z.string().regex(/^es(-[A-Z]{2})?$/).default('es'),
    zonaHoraria: z.string().regex(/^[A-Za-z_]+\/[A-Za-z_]+$/).default('America/La_Paz'),
    moneda: z.string().regex(/^[A-Z]{3}$/).default('BOB'),
  })
  .strict();

/**
 * QUITAR VALORES POR DEFECTO para las secciones de un perfil.
 *
 * `.partial()` en Zod 4 sigue aplicando los `.default()` internos: un perfil que
 * solo define `alcance.temasPermitidos` recibiría `accionesProhibidas: []` y ese
 * arreglo vacío REEMPLAZARÍA al de la base al fusionar. Un perfil debe aportar
 * solo lo que escribe; por eso acá se desenvuelven los defaults antes de hacer el
 * esquema parcial. Los tipos se conservan con un cast explícito por sección.
 */
function sinDefectos(objeto: z.ZodObject<z.ZodRawShape>): z.ZodObject<z.ZodRawShape> {
  const forma: Record<string, z.ZodType> = {};
  for (const [clave, valor] of Object.entries(objeto.shape)) {
    let s: z.ZodType = valor as z.ZodType;
    while (s instanceof z.ZodDefault || s instanceof z.ZodPrefault || s instanceof z.ZodOptional) s = (s as z.ZodDefault).unwrap() as z.ZodType;
    if (s instanceof z.ZodObject && !(s === esquemaHorarios)) s = sinDefectos(s as z.ZodObject<z.ZodRawShape>);
    forma[clave] = s.optional();
  }
  return z.object(forma).strict();
}

type Parcial<T extends z.ZodObject<z.ZodRawShape>> = ReturnType<T['partial']>;

/** Secciones que un perfil puede superponer. Todas opcionales y parciales, SIN defaults. */
export const esquemaPerfil = z
  .object({
    nombre: textoCorto(120),
    descripcion: textoOpcional(400),
    identidad: (sinDefectos(esquemaIdentidad) as unknown as Parcial<typeof esquemaIdentidad>).optional(),
    voz: (sinDefectos(esquemaVoz) as unknown as Parcial<typeof esquemaVoz>).optional(),
    operacion: (sinDefectos(esquemaOperacion) as unknown as Parcial<typeof esquemaOperacion>).optional(),
    datos: (sinDefectos(esquemaDatos) as unknown as Parcial<typeof esquemaDatos>).optional(),
    alcance: (sinDefectos(esquemaAlcance) as unknown as Parcial<typeof esquemaAlcance>).optional(),
    conocimiento: (sinDefectos(esquemaConocimiento) as unknown as Parcial<typeof esquemaConocimiento>).optional(),
    seguridad: (sinDefectos(esquemaSeguridad) as unknown as Parcial<typeof esquemaSeguridad>).optional(),
    herramientas: z.array(esquemaHerramienta).max(12).optional(),
    orientacion: (sinDefectos(esquemaOrientacion) as unknown as Parcial<typeof esquemaOrientacion>).optional(),
    mensajes: (sinDefectos(esquemaMensajes) as unknown as Parcial<typeof esquemaMensajes>).optional(),
  })
  .strict();

export const esquemaConfiguracionAgente = z
  .object({
    /** Referencia al esquema para los editores; se ignora. */
    $schema: z.string().optional(),
    version: z.literal(1),
    id: z.string().regex(ID_AGENTE),
    identidad: esquemaIdentidad,
    voz: esquemaVoz.prefault({}),
    operacion: esquemaOperacion.prefault({}),
    datos: esquemaDatos.prefault({}),
    alcance: esquemaAlcance.prefault({}),
    conocimiento: esquemaConocimiento.prefault({}),
    seguridad: esquemaSeguridad.prefault({}),
    herramientas: z.array(esquemaHerramienta).max(12).default([]),
    orientacion: esquemaOrientacion.prefault({}),
    mensajes: esquemaMensajes,
    modelo: esquemaModelo,
    perfiles: z.record(z.string().regex(ID_PERFIL), esquemaPerfil).prefault({}),
    /** Perfil que se usa cuando el cliente no indica uno. */
    perfilPorDefecto: z.string().regex(ID_PERFIL).optional(),
  })
  .strict()
  .refine((c) => !c.perfilPorDefecto || c.perfilPorDefecto in c.perfiles, {
    message: 'perfilPorDefecto debe existir en perfiles',
    path: ['perfilPorDefecto'],
  });

export type ConfiguracionAgente = z.infer<typeof esquemaConfiguracionAgente>;
export type ConfiguracionAgenteEntrada = z.input<typeof esquemaConfiguracionAgente>;
export type Perfil = z.infer<typeof esquemaPerfil>;
export type Voz = z.infer<typeof esquemaVoz>;
export type Operacion = z.infer<typeof esquemaOperacion>;
export type Datos = z.infer<typeof esquemaDatos>;
export type Alcance = z.infer<typeof esquemaAlcance>;
export type Conocimiento = z.infer<typeof esquemaConocimiento>;
export type Fuente = z.infer<typeof esquemaFuente>;
export type Seguridad = z.infer<typeof esquemaSeguridad>;
export type Herramienta = z.infer<typeof esquemaHerramienta>;
export type Orientacion = z.infer<typeof esquemaOrientacion>;
export type Mensajes = z.infer<typeof esquemaMensajes>;
export type Modelo = z.infer<typeof esquemaModelo>;
export type Identidad = z.infer<typeof esquemaIdentidad>;
export type CategoriaEntrada = (typeof CATEGORIAS_ENTRADA)[number];
export type CompuertaSalida = (typeof COMPUERTAS_SALIDA)[number];

/**
 * Configuración EFECTIVA: la base con un perfil superpuesto y sin la sección
 * `perfiles`. Es lo único que consumen el armador del prompt y el orquestador.
 */
export type ConfiguracionEfectiva = Omit<ConfiguracionAgente, 'perfiles' | 'perfilPorDefecto'> & {
  perfilId: string | null;
  perfilNombre: string | null;
};
