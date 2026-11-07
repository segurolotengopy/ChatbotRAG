/** Pruebas de la carga del banco desde el bucket en el servicio (H4c). Lector en memoria: sin bucket ni red. */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '@chatbotrag/nucleo';
import { LectorBancoGcs, type ResultadoBancoGcs } from '@chatbotrag/conocimiento-gcs';
import type { ClienteObjetos } from '@chatbotrag/conocimiento-gcs';
import { armarAgentes, type LectorBanco } from './armar-agentes.js';
import { leerEntorno } from './entorno.js';

const RUTA_KUAA = fileURLToPath(new URL('../../configuraciones/kuaa.json', import.meta.url));
const AGENTE = 'kuaa-segurolotengo';
const hash = (c: string) => createHash('sha256').update(c).digest('hex');
const MARCA = 'ZORBALEX-TEXTO-DEL-BANCO';
const BANCO = JSON.stringify({
  formato: 1,
  version: '1.0.0',
  respuestas: [{ id: 'r-uno', tema: 'precio_plan', preguntas: ['cuanto cuesta'], plantilla: `${MARCA} {{premio_plan}}.`, aprobado_por: 'Revisora Aprobadora', riesgo: 'normal' }],
});
const SHA_BANCO = hash(BANCO);

const directorios: string[] = [];
afterEach(async () => {
  await Promise.all(directorios.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function levantar(extraEntorno: Record<string, string>, lectorBanco?: () => LectorBanco, extra: { tiempoBancoMs?: number; id?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'chatbotrag-banco-'));
  directorios.push(dir);
  const contenido = extra.id ? JSON.stringify({ ...(JSON.parse(readFileSync(RUTA_KUAA, 'utf8')) as object), id: extra.id }) : readFileSync(RUTA_KUAA, 'utf8');
  await writeFile(join(dir, 'kuaa.json'), contenido);
  const entorno = leerEntorno({
    CHATBOTRAG_DIR_CONFIGURACIONES: dir,
    CHATBOTRAG_CLIENTES: JSON.stringify([{ id: 'kuaa-web', agenteId: extra.id ?? AGENTE, claveSha256: hash('x') }]),
    CHATBOTRAG_PROVEEDOR_FORZADO: 'simulado',
    ...extraEntorno,
  });
  const bitacora = new BitacoraEnMemoria();
  const agentes = await armarAgentes(entorno, { bitacora, ...(lectorBanco ? { lectorBanco } : {}), ...(extra.tiempoBancoMs ? { tiempoBancoMs: extra.tiempoBancoMs } : {}) });
  return { agentes, bitacora, armado: agentes.get(extra.id ?? AGENTE)! };
}

const BANCOS = (extra: Record<string, unknown> = {}) => ({ CHATBOTRAG_BUCKET_BANCO: 'bucket-banco', CHATBOTRAG_BANCOS: JSON.stringify({ [AGENTE]: { version: '1.0.0', sha256: SHA_BANCO, ...extra } }) });

describe('banco desde el bucket en el servicio', () => {
  it('sin variables: nada se carga, no se construye el lector y el aviso no existe (igual que hoy)', async () => {
    let construido = 0;
    const { armado, bitacora } = await levantar({}, () => {
      construido += 1;
      throw new Error('no debe construirse');
    });
    expect(construido).toBe(0);
    expect(armado.enrutadorBanco).toBeNull();
    expect(bitacora.eventos.map((e) => e.tipo)).not.toContain('banco_cargado');
    expect(bitacora.eventos.map((e) => e.tipo)).not.toContain('banco_no_cargado');
  });

  it('con variables y un cliente de objetos en memoria: carga el banco y avisa solo con enumerados', async () => {
    const cliente: ClienteObjetos = {
      async metadatos() {
        return { tamano: Buffer.byteLength(BANCO), generacion: 'g' };
      },
      async descargar(ruta) {
        expect(ruta).toBe(`${AGENTE}/1.0.0/banco.json`);
        return Buffer.from(BANCO);
      },
    };
    const { armado, bitacora } = await levantar({ APP_ENV: 'staging', ...BANCOS() }, () => new LectorBancoGcs({ bucket: 'b', cliente }) as LectorBanco);
    expect(armado.enrutadorBanco?.indice?.bancoSha256).toBe(SHA_BANCO);
    const aviso = bitacora.eventos.find((e) => e.tipo === 'banco_cargado');
    expect(aviso).toMatchObject({ agenteId: AGENTE, codigo: 'calibracion_no_declarada' });
    expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA);
    expect(JSON.stringify(bitacora.eventos)).not.toContain('bucket-banco');
  });

  it('banco que no carga: el servicio arranca, sin enrutador, con aviso del motivo', async () => {
    const resultado: ResultadoBancoGcs = { indice: null, calibracion: null, motivo: 'banco_sha_distinto' };
    const { armado, bitacora, agentes } = await levantar(BANCOS(), () => ({ cargar: async () => resultado }));
    expect(agentes.size).toBe(1);
    expect(armado.enrutadorBanco?.indice).toBeNull();
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_no_cargado')).toMatchObject({ codigo: 'banco_sha_distinto' });
  });

  it('un lector que lanza no detiene el arranque', async () => {
    const { armado, bitacora } = await levantar(BANCOS(), () => ({
      cargar: async () => {
        throw new Error(`detalle con ${MARCA}`);
      },
    }));
    expect(armado.enrutadorBanco).toEqual({ indice: null, calibracion: null, motivo: 'banco_error' });
    expect(JSON.stringify(bitacora.eventos)).not.toContain(MARCA);
  });

  it('un agenteId inexistente entre los agentes cargados detiene el arranque', async () => {
    await expect(
      levantar({ CHATBOTRAG_BUCKET_BANCO: 'bucket-banco', CHATBOTRAG_BANCOS: JSON.stringify({ 'agente-inexistente': { version: '1.0.0', sha256: SHA_BANCO } }) }, () => ({ cargar: async () => ({ indice: null, calibracion: null }) })),
    ).rejects.toThrow(/inexistentes/);
  });

  it('un lector colgado no cuelga el arranque: motivo banco_tiempo y el servicio sigue', async () => {
    // El cliente de objetos cuya descarga nunca resuelve.
    const colgado: ClienteObjetos = {
      metadatos: async () => ({ tamano: 10, generacion: 'g' }),
      descargar: () => new Promise<Buffer>(() => undefined),
    };
    const { armado, bitacora } = await levantar(BANCOS(), () => new LectorBancoGcs({ bucket: 'b', cliente: colgado }), { tiempoBancoMs: 50 });
    expect(armado.enrutadorBanco).toEqual({ indice: null, calibracion: null, motivo: 'banco_tiempo' });
    expect(bitacora.eventos.find((e) => e.tipo === 'banco_no_cargado')).toMatchObject({ codigo: 'banco_tiempo' });
  });

  it('un agente llamado constructor sin variables no encuentra una declaración heredada ni emite evento', async () => {
    const { armado, bitacora } = await levantar({}, undefined, { id: 'constructor' });
    expect(armado.enrutadorBanco).toBeNull();
    expect(bitacora.eventos.map((e) => e.tipo).filter((t) => t.startsWith('banco_'))).toEqual([]);
  });

  it('los agentes inexistentes se detectan antes de leer ningún banco', async () => {
    let lecturas = 0;
    const { bitacora } = await levantar(
      { CHATBOTRAG_BUCKET_BANCO: 'bucket-banco', CHATBOTRAG_BANCOS: JSON.stringify({ [AGENTE]: { version: '1.0.0', sha256: SHA_BANCO }, 'agente-inexistente': { version: '1.0.0', sha256: SHA_BANCO } }) },
      () => ({
        cargar: async () => {
          lecturas += 1;
          return { indice: null, calibracion: null };
        },
      }),
    ).then(
      () => {
        throw new Error('debía fallar');
      },
      () => ({ bitacora: null }),
    );
    expect(bitacora).toBeNull();
    expect(lecturas).toBe(0);
  });
});
