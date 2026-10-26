import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ErrorPaqueteGcs, LectorPaqueteGcs, crearClienteGcs, type ClienteObjetos } from './lector.js';

const gcs = vi.hoisted(() => ({ pedidos: [] as string[], bucket: '', fallo: 0 }));
vi.mock('@google-cloud/storage', () => ({
  Storage: class {
    bucket(nombre: string) {
      gcs.bucket = nombre;
      return {
        file: (ruta: string) => ({
          async download() {
            gcs.pedidos.push(ruta);
            if (gcs.fallo) throw Object.assign(new Error('x'), { code: gcs.fallo });
            return [Buffer.from('contenido-falso', 'utf8')];
          },
        }),
      };
    }
  },
}));

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

function cliente(objetos: Record<string, string>, fallo?: { ruta: string; code: number }): ClienteObjetos & { pedidos: string[] } {
  const pedidos: string[] = [];
  return {
    pedidos,
    async descargar(ruta) {
      pedidos.push(ruta);
      if (fallo && ruta === fallo.ruta) throw Object.assign(new Error('detalle-interno-con-bucket'), { code: fallo.code });
      const o = objetos[ruta];
      if (o === undefined) throw Object.assign(new Error('no existe'), { code: 404 });
      return Buffer.from(o, 'utf8');
    },
  };
}

const contenido = '[{"id":"x"}]';
const manifiesto = (extra: Record<string, unknown> = {}) => JSON.stringify({ version: '1.0.0', archivos: [{ ruta: 'a.json', titular: 'interseguros', sha256: sha(contenido), ...extra }] });

async function codigoDe(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ErrorPaqueteGcs);
    expect((e as Error).message).not.toMatch(/bucket|detalle-interno/);
    return (e as ErrorPaqueteGcs).codigo;
  }
  return 'SIN_ERROR';
}

describe('LectorPaqueteGcs', () => {
  it('lee el manifiesto y un archivo cuya huella coincide, bajo la carpeta de la versión', async () => {
    const c = cliente({ '1.0.0/manifiesto.json': manifiesto(), '1.0.0/a.json': contenido });
    const l = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: c });
    expect((await l.leerManifiesto()).version).toBe('1.0.0');
    expect(await l.leer('a.json')).toBe(contenido);
    expect(c.pedidos).toEqual(['1.0.0/manifiesto.json', '1.0.0/a.json']);
  });

  it('una huella distinta invalida el archivo', async () => {
    const c = cliente({ '1.0.0/manifiesto.json': manifiesto(), '1.0.0/a.json': 'otro contenido' });
    const l = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: c });
    await l.leerManifiesto();
    expect(await codigoDe(l.leer('a.json'))).toBe('INTEGRIDAD');
  });

  it('un archivo sin huella, fuera del manifiesto o antes de leer el manifiesto no se descarga', async () => {
    const c = cliente({ '1.0.0/manifiesto.json': manifiesto({ sha256: undefined }), '1.0.0/a.json': contenido, '1.0.0/z.json': 'x' });
    const l = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: c });
    expect(await codigoDe(l.leer('a.json'))).toBe('INTEGRIDAD');
    await l.leerManifiesto();
    expect(await codigoDe(l.leer('a.json'))).toBe('INTEGRIDAD');
    expect(await codigoDe(l.leer('z.json'))).toBe('INTEGRIDAD');
    expect(c.pedidos).toEqual(['1.0.0/manifiesto.json']);
  });

  it('un 403 y un 404 se convierten en errores tipados sin filtrar detalles', async () => {
    const l403 = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: cliente({}, { ruta: '1.0.0/manifiesto.json', code: 403 }) });
    expect(await codigoDe(l403.leerManifiesto())).toBe('NO_AUTORIZADO');
    const l404 = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: cliente({}) });
    expect(await codigoDe(l404.leerManifiesto())).toBe('NO_ENCONTRADO');
    const l500 = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: cliente({}, { ruta: '1.0.0/manifiesto.json', code: 500 }) });
    expect(await codigoDe(l500.leerManifiesto())).toBe('ERROR');
  });

  it('un manifiesto que no es JSON o no cumple la forma da MANIFIESTO', async () => {
    const roto = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: cliente({ '1.0.0/manifiesto.json': '{no' }) });
    expect(await codigoDe(roto.leerManifiesto())).toBe('MANIFIESTO');
    const malo = new LectorPaqueteGcs({ bucket: 'b', version: '1.0.0', cliente: cliente({ '1.0.0/manifiesto.json': '{"version":"x","archivos":[]}' }) });
    expect(await codigoDe(malo.leerManifiesto())).toBe('MANIFIESTO');
  });
});

describe('crearClienteGcs', () => {
  it('descarga del bucket indicado con la identidad del entorno (cliente falso)', async () => {
    gcs.fallo = 0;
    const c = crearClienteGcs('mi-bucket');
    expect((await c.descargar('1.0.0/a.json')).toString('utf8')).toBe('contenido-falso');
    expect(gcs.bucket).toBe('mi-bucket');
    expect(gcs.pedidos).toEqual(['1.0.0/a.json']);
  });

  it('propaga el código del error para que el lector lo traduzca', async () => {
    gcs.fallo = 403;
    const l = new LectorPaqueteGcs({ bucket: 'mi-bucket', version: '1.0.0' });
    expect(await codigoDe(l.leerManifiesto())).toBe('NO_AUTORIZADO');
    gcs.fallo = 0;
  });
});
