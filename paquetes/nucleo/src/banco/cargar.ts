/**
 * CARGADOR DEL BANCO DE RESPUESTAS
 *
 * Por qué existe: el banco vive en un bucket y llega como texto. Antes de usarlo se verifica su integridad
 * (SHA-256 fijado por quien lo publica), su forma (esquema estricto), que cada plantilla use solo variables de la
 * lista cerrada y que no contenga nada con forma de secreto. Todos los hallazgos de forma y de variables se
 * reúnen en una sola excepción para corregir el banco de una vez.
 *
 * Defecto que motiva el control: un banco alterado en el bucket, o editado con una variable inventada o una clave
 * pegada por error, llegaría al cliente. Por seguridad, los errores nunca muestran valores del banco ni hashes.
 *
 * Qué NO garantiza: que el SHA esperado sea el correcto (lo fija quien despliega), ni que los textos sean
 * adecuados (eso lo da `aprobado_por`). No hace red ni lee archivos: recibe el texto ya leído. Rechaza el banco
 * sintético (descripción o `aprobado_por` de ejemplo) salvo que se pida `admitirSintetico` (solo pruebas), pero eso
 * no frena a un autor malintencionado: quien edite el banco puede evitar esas marcas. Tampoco admite llaves en los
 * textos de derivación ni en las aclaraciones, que no llevan variables.
 */
import { createHash } from 'node:crypto';
import { pareceSecreto } from '../configuracion/cargar.js';
import { APROBADO_POR_SINTETICO, BancoRespuestas, normalizarParaTerminos, normalizarPregunta } from './esquema.js';
import { variablesDe } from './plantillas.js';

export class ErrorBanco extends Error {
  constructor(
    mensaje: string,
    public readonly detalles: string[] = [],
  ) {
    super(mensaje);
    this.name = 'ErrorBanco';
  }
}

export interface BancoCargado {
  banco: BancoRespuestas;
  sha256: string;
}

function recorrerSecretos(valor: unknown, ruta: string, hallazgos: string[]): void {
  if (typeof valor === 'string') {
    if (pareceSecreto(valor)) hallazgos.push(`${ruta}: el valor parece un secreto`);
    return;
  }
  if (Array.isArray(valor)) {
    valor.forEach((v, i) => recorrerSecretos(v, `${ruta}[${i}]`, hallazgos));
    return;
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) recorrerSecretos(v, `${ruta}.${k}`, hallazgos);
  }
}

function esSintetico(banco: BancoRespuestas): boolean {
  if (/\bsintetic[oa]s?\b/.test(normalizarParaTerminos(banco.descripcion ?? ''))) return true;
  const aprobadores = [
    ...banco.respuestas.map((e) => e.aprobado_por),
    ...banco.derivaciones.map((e) => e.aprobado_por),
    ...banco.textos_derivacion.map((e) => e.aprobado_por),
    ...Object.values(banco.aclaraciones).flatMap((a) => (a ? [a.aprobado_por] : [])),
  ];
  return aprobadores.some((x) => normalizarPregunta(x) === APROBADO_POR_SINTETICO);
}

export function cargarBanco(contenido: string, opciones: { sha256Esperado?: string; admitirSintetico?: boolean } = {}): BancoCargado {
  const sha256 = createHash('sha256').update(contenido, 'utf8').digest('hex');
  if (opciones.sha256Esperado !== undefined && opciones.sha256Esperado.toLowerCase() !== sha256) {
    throw new ErrorBanco('sha256 no coincide');
  }

  let crudo: unknown;
  try {
    crudo = JSON.parse(contenido);
  } catch {
    throw new ErrorBanco('JSON inválido');
  }

  const analisis = BancoRespuestas.safeParse(crudo);
  if (!analisis.success) {
    throw new ErrorBanco(
      'banco inválido',
      analisis.error.issues.map((i) => {
        const ruta = i.path.join('.') || '(raíz)';
        // Zod nombra la clave sobrante en su mensaje; podría ser un secreto pegado por error.
        return i.code === 'unrecognized_keys' ? `${ruta}: clave no admitida` : `${ruta}: ${i.message}`;
      }),
    );
  }
  const banco = analisis.data;

  const detalles: string[] = [];
  banco.respuestas.forEach((r, i) => {
    const { desconocidas, malformada } = variablesDe(r.plantilla);
    const ruta = `respuestas.${i}.plantilla`;
    if (desconocidas.length > 0) detalles.push(`${ruta}: variable desconocida`);
    if (malformada) detalles.push(`${ruta}: llaves mal formadas`);
  });
  const sinLlaves = (texto: string, ruta: string) => {
    if (/[{}]/.test(texto)) detalles.push(`${ruta}: llaves no admitidas`);
  };
  banco.derivaciones.forEach((d, i) => sinLlaves(d.texto, `derivaciones.${i}.texto`));
  banco.textos_derivacion.forEach((t, i) => sinLlaves(t.texto, `textos_derivacion.${i}.texto`));
  for (const [clave, a] of Object.entries(banco.aclaraciones)) if (a) sinLlaves(a.texto, `aclaraciones.${clave}.texto`);
  if (detalles.length > 0) throw new ErrorBanco('banco inválido', detalles);

  const secretos: string[] = [];
  recorrerSecretos(banco, 'banco', secretos);
  if (secretos.length > 0) throw new ErrorBanco('el banco contiene valores con forma de secreto', secretos);

  if (opciones.admitirSintetico !== true && esSintetico(banco)) throw new ErrorBanco('banco sintético fuera de pruebas');

  return { banco, sha256 };
}
