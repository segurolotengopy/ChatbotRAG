/**
 * PRUEBAS DE LA RESPUESTA CORTADA O VACÍA (batería de staging del 24-oct-2026)
 *
 * Origen: PAG-solicitud-vencida-005 terminó con `MAX_TOKENS` en mitad de una frase; PAG-revision-manual-005
 * y PAG-retracto-006 derivaron con la herramienta y luego el modelo devolvió texto vacío, y el orquestador
 * lo presentó como error temporal. Con un proveedor falso por secuencia se fija: un texto cortado NO se
 * entrega (ni recortado: cortar en la «última oración» puede dejar una afirmación sin su salvedad); se
 * entrega el error temporal más la derivación; la derivación por herramienta sin texto usa el mensaje
 * configurado, y una respuesta vacía SIN derivación sigue siendo error temporal.
 *
 * Qué NO garantiza: que el aviso baste para saber por qué se cortó. No se reintenta (repetiría la entrada
 * completa).
 */
import { describe, expect, it } from 'vitest';
import { BitacoraEnMemoria } from '../bitacora/bitacora-consola.js';
import { validarConfiguracion } from '../configuracion/cargar.js';
import { RegistroHerramientas } from '../herramientas/registro.js';
import { MemoriaEnProceso } from '../memoria/memoria-en-proceso.js';
import type { PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { Agente } from './agente.js';

const config = validarConfiguracion({ ...CONFIG_PRUEBA, conocimiento: { modo: 'solo_prompt' } });

/** Texto real (recortado a lo necesario) de PAG-solicitud-vencida-005: cortado dentro de una comilla. */
const TEXTO_CORTADO =
  'Comprendo que su solicitud aparece como vencida y que usted realizó un pago. Le informo que, como asistente virtual, no puedo procesar devoluciones de dinero directamente.\n\nSi en su pantalla de "Solicitud vencida" se indica que hubo un pago acreditado, verá la sección "PROCEDIMIENTO';

const uso = { tokensEntrada: 10, tokensSalida: 5 };
const fin = (texto: string, motivoFin: RespuestaLLM['motivoFin'] = 'fin'): RespuestaLLM => ({ texto, llamadasHerramienta: [], motivoFin, uso });
const derivar: RespuestaLLM = { texto: '', llamadasHerramienta: [{ id: 'h1', nombre: 'derivar_humano', argumentos: { motivo: 'consulta' } }], motivoFin: 'herramienta', uso };

function proveedorPorSecuencia(respuestas: RespuestaLLM[]): ProveedorLLM & { llamadas: number; peticiones: PeticionLLM[] } {
  const p = {
    nombre: 'secuencia',
    llamadas: 0,
    peticiones: [] as PeticionLLM[],
    async generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
      p.peticiones.push(peticion);
      const r = respuestas[p.llamadas];
      p.llamadas++;
      if (!r) throw new Error('el proveedor falso se quedó sin respuestas');
      return r;
    },
  };
  return p;
}

async function preguntar(respuestas: RespuestaLLM[]) {
  const proveedor = proveedorPorSecuencia(respuestas);
  const bitacora = new BitacoraEnMemoria();
  const agente = new Agente({ config, proveedor, indice: null, memoria: new MemoriaEnProceso(), herramientas: new RegistroHerramientas(), bitacora, reloj: () => new Date('2026-10-24T14:00:00Z') });
  const r = await agente.responder({ conversacionId: 'conv-cortada-0001', texto: 'Mi solicitud venció y pagué, ¿me devuelven el dinero?', canal: 'web' });
  return { r, proveedor, bitacora };
}

describe('respuesta cortada por max_tokens', () => {
  it('no se entrega: sale el error temporal más la derivación, con aviso; una sola llamada al proveedor', async () => {
    const { r, proveedor } = await preguntar([fin(TEXTO_CORTADO, 'max_tokens')]);
    expect(proveedor.llamadas).toBe(1);
    expect(r.texto).toBe(`${config.mensajes.errorTemporal}\n\n${config.mensajes.derivacion}`);
    expect(r.texto).not.toContain('Comprendo');
    expect(r.texto).not.toContain('PROCEDIMIENTO');
    expect(r.derivacion).toEqual({ motivo: 'respuesta_cortada' });
    expect(r.avisos).toEqual(expect.arrayContaining(['max_tokens', 'respuesta_incompleta']));
    expect(r.avisos).not.toContain('respuesta_vacia');
  });

  it('una afirmación sin su salvedad no sale (ni «Gs.» ni «1.» cortan a medias)', async () => {
    for (const cortado of ['El plan cubre cáncer de mama. Excepto cuando', 'El precio es Gs. 150.000 al mes, sin incluir', 'Paso 1. Ingrese su correo']) {
      const { r } = await preguntar([fin(cortado, 'max_tokens')]);
      expect(r.texto.startsWith(config.mensajes.errorTemporal)).toBe(true);
      expect(r.texto).not.toContain(cortado.slice(0, 12));
    }
  });

  it('un texto cortado que llamó a una herramienta no cuenta como corte final', async () => {
    const cortadoConHerramienta: RespuestaLLM = { ...derivar, texto: 'Texto a medias', motivoFin: 'max_tokens' };
    const { r } = await preguntar([cortadoConHerramienta, fin('Listo, le derivé. Gracias.')]);
    expect(r.avisos).not.toContain('respuesta_incompleta');
  });

  it('conserva el motivo de una derivación anterior y no lo tapa con respuesta_cortada', async () => {
    const { r } = await preguntar([derivar, fin(TEXTO_CORTADO, 'max_tokens')]);
    expect(r.avisos).toContain('respuesta_incompleta');
    expect(r.derivacion).not.toBeNull();
    expect(r.derivacion?.motivo).not.toBe('respuesta_cortada');
  });
});

describe('derivar con herramienta y luego texto vacío', () => {
  it('usa el mensaje de derivación sin error temporal ni duplicarlo; dos llamadas', async () => {
    const { r, proveedor } = await preguntar([derivar, fin('')]);
    expect(proveedor.llamadas).toBe(2);
    expect(r.texto).toBe(config.mensajes.derivacion);
    expect(r.texto).not.toBe(config.mensajes.errorTemporal);
    expect(r.derivacion).not.toBeNull();
    expect(r.avisos).toContain('vacia_con_derivacion');
    expect(r.avisos).not.toContain('respuesta_vacia');
  });
});

describe('respuesta vacía sin derivación', () => {
  it('sigue siendo error temporal con respuesta_vacia', async () => {
    const { r, proveedor } = await preguntar([fin('')]);
    expect(proveedor.llamadas).toBe(1);
    expect(r.texto).toBe(config.mensajes.errorTemporal);
    expect(r.avisos).toContain('respuesta_vacia');
    expect(r.avisos).not.toContain('vacia_con_derivacion');
  });
});

describe('bitácora', () => {
  it('los avisos nuevos son enumerados y la bitácora no lleva texto', async () => {
    const { bitacora } = await preguntar([fin(TEXTO_CORTADO, 'max_tokens')]);
    const crudo = JSON.stringify(bitacora.eventos);
    expect(crudo).toContain('respuesta_incompleta');
    expect(crudo).not.toContain('Comprendo que');
    expect(crudo).not.toContain('venció y pagué');
  });
});
