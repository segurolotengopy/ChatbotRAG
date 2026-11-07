/** Pruebas del lector del banco desde el bucket (H4c). Cliente de objetos falso en memoria: sin red. */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { VERSION_REGLA_DECISION } from '@chatbotrag/nucleo';
import { LectorBancoGcs, TOPE_BYTES_BANCO, TOPE_BYTES_CALIBRACION, type DeclaracionBanco } from './lector-banco.js';
import type { ClienteObjetos } from './lector.js';

const sha = (t: string) => createHash('sha256').update(t).digest('hex');

const bancoObj = (cambios: Record<string, unknown> = {}) => ({
  formato: 1,
  version: '1.0.0',
  respuestas: [{ id: 'r-uno', tema: 'precio_plan', preguntas: ['cuanto cuesta el plan'], plantilla: 'Texto aprobado {{premio_plan}}.', aprobado_por: 'Revisora Aprobadora', riesgo: 'normal' }],
  ...cambios,
});
const BANCO = JSON.stringify(bancoObj());
const SHA_BANCO = sha(BANCO);
const calObj = (cambios: Record<string, unknown> = {}) => ({
  formato: 1,
  regla: VERSION_REGLA_DECISION,
  banco_sha256: SHA_BANCO,
  evaluacion_sha256: 'b'.repeat(64),
  proveedor: 'vertex',
  modelo: 'vertex-embeddings:modelo-prueba',
  dimension: 8,
  umbral_fijo: 0.82,
  umbral_derivacion: 0.7,
  margen: 0.05,
  valido: true,
  motivos_invalidez: [],
  control: { total: 120, confusiones: 0, falsos_positivos: 0 },
  medido: '2026-11-04',
  ...cambios,
});
const CAL = JSON.stringify(calObj());

function cliente(objetos: Record<string, string>, fallo?: { ruta: string; code: number }): ClienteObjetos & { pedidos: string[]; generaciones: string[] } {
  const pedidos: string[] = [];
  const generaciones: string[] = [];
  return {
    pedidos,
    generaciones,
    async metadatos(ruta) {
      if (fallo && ruta === fallo.ruta) throw Object.assign(new Error('detalle-interno-con-bucket'), { code: fallo.code });
      const o = objetos[ruta];
      if (o === undefined) throw Object.assign(new Error('no existe'), { code: 404 });
      return { tamano: Buffer.byteLength(o), generacion: `g-${ruta}` };
    },
    async descargar(ruta, generacion) {
      pedidos.push(ruta);
      generaciones.push(generacion);
      const o = objetos[ruta];
      if (o === undefined) throw Object.assign(new Error('no existe'), { code: 404 });
      return Buffer.from(o, 'utf8');
    },
  };
}

const RB = 'agente-uno/1.0.0/banco.json';
const RC = 'agente-uno/1.0.0/calibracion.json';
const decl = (extra: Partial<DeclaracionBanco> = {}): DeclaracionBanco => ({ version: '1.0.0', sha256: SHA_BANCO, sha256Calibracion: sha(CAL), ...extra });
const lector = (c: ClienteObjetos) => new LectorBancoGcs({ bucket: 'b', cliente: c });
const cargar = (c: ClienteObjetos, d: DeclaracionBanco, admitirSintetico = false) => lector(c).cargar('agente-uno', d, { admitirSintetico });

describe('LectorBancoGcs', () => {
  it('carga feliz: banco y calibración, bajo <agente>/<versión>/ y por generación exacta', async () => {
    const c = cliente({ [RB]: BANCO, [RC]: CAL });
    const r = await cargar(c, decl());
    expect(r.motivo).toBeUndefined();
    expect(r.indice?.bancoSha256).toBe(SHA_BANCO);
    expect(r.calibracion?.banco_sha256).toBe(SHA_BANCO);
    expect(c.pedidos).toEqual([RB, RC]);
    expect(c.generaciones).toEqual([`g-${RB}`, `g-${RC}`]);
  });

  it('sin calibración declarada: banco cargado, no se lee calibracion.json', async () => {
    const c = cliente({ [RB]: BANCO, [RC]: CAL });
    const r = await cargar(c, decl({ sha256Calibracion: undefined }));
    expect(r.indice).not.toBeNull();
    expect(r.calibracion).toBeNull();
    expect(r.motivo).toBe('calibracion_no_declarada');
    expect(c.pedidos).toEqual([RB]);
  });

  it('calibración declarada pero ausente: el banco queda con coincidencia exacta', async () => {
    const r = await cargar(cliente({ [RB]: BANCO }), decl());
    expect(r.indice).not.toBeNull();
    expect(r.calibracion).toBeNull();
    expect(r.motivo).toBe('calibracion_ausente');
  });

  it('SHA del banco distinto: no se carga y no se descarga más allá del banco', async () => {
    const c = cliente({ [RB]: BANCO, [RC]: CAL });
    const r = await cargar(c, decl({ sha256: 'c'.repeat(64) }));
    expect(r).toEqual({ indice: null, calibracion: null, motivo: 'banco_sha_distinto' });
    expect(c.pedidos).toEqual([RB]);
  });

  it('banco alterado en el bucket (un byte): SHA distinto', async () => {
    const r = await cargar(cliente({ [RB]: BANCO + ' ', [RC]: CAL }), decl());
    expect(r.motivo).toBe('banco_sha_distinto');
    expect(r.indice).toBeNull();
  });

  it('SHA de la calibración distinto: se ignora, el banco se conserva', async () => {
    const r = await cargar(cliente({ [RB]: BANCO, [RC]: CAL }), decl({ sha256Calibracion: 'd'.repeat(64) }));
    expect(r.indice).not.toBeNull();
    expect(r.calibracion).toBeNull();
    expect(r.motivo).toBe('calibracion_sha_distinto');
  });

  it('banco demasiado grande: se rechaza por los metadatos, sin descargar', async () => {
    const c = cliente({});
    c.metadatos = async () => ({ tamano: TOPE_BYTES_BANCO + 1, generacion: 'g' });
    const r = await cargar(c, decl());
    expect(r.motivo).toBe('banco_demasiado_grande');
    expect(c.pedidos).toEqual([]);
  });

  it('calibración demasiado grande: se ignora', async () => {
    const grande = 'x'.repeat(TOPE_BYTES_CALIBRACION + 1);
    const r = await cargar(cliente({ [RB]: BANCO, [RC]: grande }), decl({ sha256Calibracion: sha(grande) }));
    expect(r.indice).not.toBeNull();
    expect(r.motivo).toBe('calibracion_demasiado_grande');
  });

  it('banco sintético fuera de test se rechaza; en test se admite', async () => {
    const sintetico = JSON.stringify(bancoObj({ descripcion: 'Banco sintético de prueba' }));
    const c = cliente({ [RB]: sintetico });
    const d = decl({ sha256: sha(sintetico), sha256Calibracion: undefined });
    expect((await cargar(c, d, false)).motivo).toBe('banco_sintetico');
    expect((await cargar(c, d, true)).indice).not.toBeNull();
  });

  it('banco con JSON o forma inválidos: banco_invalido', async () => {
    for (const malo of ['no es json', JSON.stringify({ formato: 1 })]) {
      const r = await cargar(cliente({ [RB]: malo }), decl({ sha256: sha(malo) }));
      expect(r).toEqual({ indice: null, calibracion: null, motivo: 'banco_invalido' });
    }
  });

  it('calibración con JSON o forma inválidos: calibracion_invalida', async () => {
    for (const mala of ['no es json', JSON.stringify(calObj({ clave_extra: 'valor-secreto' }))]) {
      const r = await cargar(cliente({ [RB]: BANCO, [RC]: mala }), decl({ sha256Calibracion: sha(mala) }));
      expect(r.indice).not.toBeNull();
      expect(r.calibracion).toBeNull();
      expect(r.motivo).toBe('calibracion_invalida');
    }
  });

  it('calibración de otro banco, de otra regla o no válida: calibracion_no_apta', async () => {
    const casos = [calObj({ banco_sha256: 'e'.repeat(64) }), calObj({ regla: VERSION_REGLA_DECISION + 1 }), calObj({ valido: false, motivos_invalidez: ['minimos_insuficientes'] })];
    for (const c of casos) {
      const t = JSON.stringify(c);
      const r = await cargar(cliente({ [RB]: BANCO, [RC]: t }), decl({ sha256Calibracion: sha(t) }));
      expect(r.indice).not.toBeNull();
      expect(r.calibracion).toBeNull();
      expect(r.motivo).toBe('calibracion_no_apta');
    }
  });

  it('objeto del banco ausente: banco_ausente', async () => {
    expect(await cargar(cliente({}), decl())).toEqual({ indice: null, calibracion: null, motivo: 'banco_ausente' });
  });

  it('errores del cliente de objetos: se traducen a motivos sin filtrar el detalle y no lanzan', async () => {
    const e403 = await cargar(cliente({ [RB]: BANCO }, { ruta: RB, code: 403 }), decl());
    expect(e403.motivo).toBe('banco_no_autorizado');
    const e500 = await cargar(cliente({ [RB]: BANCO }, { ruta: RB, code: 500 }), decl());
    expect(e500.motivo).toBe('banco_error');
    expect(JSON.stringify(e500)).not.toMatch(/detalle-interno|bucket/);
    const cal403 = await cargar(cliente({ [RB]: BANCO, [RC]: CAL }, { ruta: RC, code: 403 }), decl());
    expect(cal403.indice).not.toBeNull();
    expect(cal403.motivo).toBe('calibracion_no_autorizada');
    const cal500 = await cargar(cliente({ [RB]: BANCO, [RC]: CAL }, { ruta: RC, code: 500 }), decl());
    expect(cal500.motivo).toBe('calibracion_error');
  });

  it('descarga mayor que el tope aunque los metadatos digan otra cosa: se rechaza', async () => {
    const c = cliente({});
    c.metadatos = async () => ({ tamano: 10, generacion: 'g' });
    c.descargar = async () => Buffer.alloc(TOPE_BYTES_BANCO + 1, 'x');
    expect((await cargar(c, decl())).motivo).toBe('banco_demasiado_grande');
    const c2 = cliente({ [RB]: BANCO });
    c2.metadatos = async (ruta) => ({ tamano: ruta === RB ? Buffer.byteLength(BANCO) : 10, generacion: 'g' });
    const original = c2.descargar.bind(c2);
    c2.descargar = async (ruta, g) => (ruta === RC ? Buffer.alloc(TOPE_BYTES_CALIBRACION + 1, 'x') : original(ruta, g));
    expect((await cargar(c2, decl())).motivo).toBe('calibracion_demasiado_grande');
  });

  it('el código 401 se traduce a no autorizado', async () => {
    expect((await cargar(cliente({ [RB]: BANCO }, { ruta: RB, code: 401 }), decl())).motivo).toBe('banco_no_autorizado');
  });

  it('calibración medida con el proveedor simulado: no apta fuera de pruebas, admitida en pruebas', async () => {
    const t = JSON.stringify(calObj({ proveedor: 'simulado' }));
    const c = cliente({ [RB]: BANCO, [RC]: t });
    const d = decl({ sha256Calibracion: sha(t) });
    const fuera = await cargar(c, d, false);
    expect(fuera.calibracion).toBeNull();
    expect(fuera.motivo).toBe('calibracion_no_apta');
    expect((await cargar(c, d, true)).calibracion).not.toBeNull();
  });

  it('UTF-8 inválido con el SHA correcto sale como banco_invalido', async () => {
    const malo = Buffer.from([0x7b, 0xff, 0xfe, 0x7d]);
    const c: ClienteObjetos = { metadatos: async () => ({ tamano: malo.length, generacion: 'g' }), descargar: async () => malo };
    const r = await cargar(c, decl({ sha256: createHash('sha256').update(malo).digest('hex') }));
    expect(r.motivo).toBe('banco_invalido');
  });

  it('el resultado no contiene texto del banco', async () => {
    const r = await cargar(cliente({ [RB]: 'no es json con TEXTO-SECRETO' }), decl({ sha256: sha('no es json con TEXTO-SECRETO') }));
    expect(JSON.stringify(r)).not.toContain('TEXTO-SECRETO');
  });
});
