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
  GCP_PROYECTO: z.string().optional(),
  GCP_REGION: z.string().default('us-central1'),
  AWS_REGION: z.string().default('us-east-1'),
  NODE_ENV: z.string().default('development'),
});

export interface Entorno extends z.infer<typeof esquemaEntorno> {
  clientes: Cliente[];
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
  return { ...r.data, clientes: clientes.data };
}
