/**
 * ENTORNO DEL SERVICIO
 *
 * Todo lo que el servicio necesita del exterior entra por variables de entorno y
 * se valida acá, una vez, al arrancar. Ningún módulo lee `process.env` por su
 * cuenta. Las credenciales de nube NO están acá: las toma el SDK de la identidad
 * del entorno (cuenta de servicio de Cloud Run, rol de la tarea, ADC local).
 *
 * CLIENTES. La autenticación de quien llama al servicio (el sitio, la app, el
 * puente de WhatsApp) se define en `CHATBOTRAG_CLIENTES`: un JSON con id, agente y
 * el SHA-256 de la clave. Nunca la clave en claro: si la variable se filtra (una
 * consola, un volcado), no hay nada que usar. El agente que atiende sale del
 * cliente autenticado, jamás del cuerpo de la petición.
 */
import { z } from 'zod';

export const esquemaCliente = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
    agenteId: z.string().regex(/^[a-z0-9][a-z0-9-]{2,59}$/),
    claveSha256: z.string().regex(/^[a-f0-9]{64}$/),
    /** Orígenes permitidos para CORS cuando un navegador llama directo. Vacío = sin CORS. */
    origenes: z.array(z.string().url()).max(10).default([]),
    /** Peticiones por minuto para este cliente (además del límite por IP). */
    limitePorMinuto: z.number().int().min(1).max(10000).default(600),
  })
  .strict();

export type Cliente = z.infer<typeof esquemaCliente>;

export const esquemaEntorno = z.object({
  PUERTO: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Directorio con los `*.json` de agentes y su carpeta `corpus/`. */
  CHATBOTRAG_DIR_CONFIGURACIONES: z.string().min(1).default('./configuraciones'),
  CHATBOTRAG_CLIENTES: z.string().min(2),
  /** `simulado` fuerza el proveedor simulado en todos los agentes (desarrollo/pruebas). */
  CHATBOTRAG_PROVEEDOR_FORZADO: z.enum(['simulado']).optional(),
  /** Índice: `memoria` (por defecto) o `pgvector` (requiere PGVECTOR_URL). */
  CHATBOTRAG_INDICE: z.enum(['memoria', 'pgvector']).default('memoria'),
  PGVECTOR_URL: z.string().url().optional(),
  /** Límite global por IP (peticiones por minuto). */
  CHATBOTRAG_LIMITE_IP_MINUTO: z.coerce.number().int().min(1).default(60),
  /** Secreto HMAC para firmar las llamadas a herramientas `http`. Opcional. */
  CHATBOTRAG_HMAC_HERRAMIENTAS: z.string().min(16).optional(),
  /** Ambiente que fija deploy.sh (`staging` | `production`). Con `production` el paquete no validado está vedado. */
  APP_ENV: z.string().optional(),
  /**
   * Perfil del conocimiento de Kuaa. Ausente o vacío = `produccion`; `pruebas` lo activa; cualquier otro valor
   * («PRUEBAS», «staging») es un error de entorno: un typo no debe pasar por una configuración válida.
   */
  CHATBOTRAG_PERFIL_CONOCIMIENTO: z.string().optional(),
  /** Bucket privado con el paquete de conocimiento no validado. Solo con perfil `pruebas`. */
  CHATBOTRAG_BUCKET_PAQUETE: z.string().regex(/^[a-z0-9][a-z0-9._-]{2,62}$/).optional(),
  /** Versión X.Y.Z del paquete dentro del bucket. Solo con perfil `pruebas`. */
  CHATBOTRAG_VERSION_PAQUETE: z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+$/).optional(),
  GCP_PROYECTO: z.string().optional(),
  GCP_REGION: z.string().default('us-central1'),
  AWS_REGION: z.string().default('us-east-1'),
  NODE_ENV: z.string().default('development'),
});

export interface Entorno extends z.infer<typeof esquemaEntorno> {
  clientes: Cliente[];
  /** Perfil efectivo del conocimiento: `produccion` salvo que la variable valga exactamente `pruebas`. */
  perfilConocimiento: 'produccion' | 'pruebas';
}

export class ErrorEntorno extends Error {
  constructor(public readonly detalles: string[]) {
    super(`Entorno inválido: ${detalles.join('; ')}`);
    this.name = 'ErrorEntorno';
  }
}

export function leerEntorno(fuente: NodeJS.ProcessEnv = process.env): Entorno {
  const r = esquemaEntorno.safeParse(fuente);
  if (!r.success) throw new ErrorEntorno(r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  let clientesCrudos: unknown;
  try {
    clientesCrudos = JSON.parse(r.data.CHATBOTRAG_CLIENTES);
  } catch {
    throw new ErrorEntorno(['CHATBOTRAG_CLIENTES no es JSON válido']);
  }
  const clientes = z.array(esquemaCliente).min(1).safeParse(clientesCrudos);
  if (!clientes.success) throw new ErrorEntorno(clientes.error.issues.map((i) => `CHATBOTRAG_CLIENTES.${i.path.join('.')}: ${i.message}`));
  const ids = new Set<string>();
  for (const c of clientes.data) {
    if (ids.has(c.id)) throw new ErrorEntorno([`CHATBOTRAG_CLIENTES: id de cliente duplicado «${c.id}»`]);
    ids.add(c.id);
  }
  if (r.data.CHATBOTRAG_INDICE === 'pgvector' && !r.data.PGVECTOR_URL) throw new ErrorEntorno(['CHATBOTRAG_INDICE=pgvector exige PGVECTOR_URL']);
  const crudoPerfil = r.data.CHATBOTRAG_PERFIL_CONOCIMIENTO;
  if (crudoPerfil !== undefined && crudoPerfil !== '' && crudoPerfil !== 'pruebas' && crudoPerfil !== 'produccion') {
    throw new ErrorEntorno(['CHATBOTRAG_PERFIL_CONOCIMIENTO debe ser «produccion» o «pruebas»']);
  }
  const perfilConocimiento: 'produccion' | 'pruebas' = crudoPerfil === 'pruebas' ? 'pruebas' : 'produccion';
  const bucket = r.data.CHATBOTRAG_BUCKET_PAQUETE;
  const version = r.data.CHATBOTRAG_VERSION_PAQUETE;
  // El ambiente de producción jamás admite el paquete no validado, ni su perfil ni su bucket.
  if (r.data.APP_ENV === 'production' && (perfilConocimiento === 'pruebas' || bucket !== undefined)) {
    throw new ErrorEntorno(['APP_ENV=production no admite CHATBOTRAG_PERFIL_CONOCIMIENTO=pruebas ni CHATBOTRAG_BUCKET_PAQUETE']);
  }
  // Combinaciones incoherentes: fallan el arranque en vez de adivinar la intención.
  if (perfilConocimiento === 'pruebas' && (!bucket || !version)) throw new ErrorEntorno(['CHATBOTRAG_PERFIL_CONOCIMIENTO=pruebas exige CHATBOTRAG_BUCKET_PAQUETE y CHATBOTRAG_VERSION_PAQUETE']);
  if (perfilConocimiento === 'produccion' && (bucket || version)) throw new ErrorEntorno(['CHATBOTRAG_BUCKET_PAQUETE y CHATBOTRAG_VERSION_PAQUETE solo se admiten con CHATBOTRAG_PERFIL_CONOCIMIENTO=pruebas']);
  return { ...r.data, clientes: clientes.data, perfilConocimiento };
}
