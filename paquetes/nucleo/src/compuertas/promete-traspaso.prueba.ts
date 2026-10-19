/**
 * PRUEBA DE LA COMPUERTA `promete_traspaso` Y DEL MODO «canal» DE LA HERRAMIENTA
 *
 * Origen: batería CASOS-v1.0 del 12-oct-2026. En 40 de 368 casos el asistente ofreció
 * «derivarle con un asesor humano» en un canal sin traspaso. Se prueban las dos
 * direcciones: que quite la promesa y que NO toque una respuesta legítima.
 *
 * Qué NO garantiza: solo cubre las formas de la expresión; otra redacción pasa.
 */
import { describe, expect, it } from 'vitest';
import { validarConfiguracion } from '../configuracion/cargar.js';
import { ErrorConfiguracion } from '../configuracion/cargar.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { INDICACION_DERIVAR } from '../prompt/frases.js';
import { INTERNAS } from '../herramientas/internas.js';
import { aplicarCompuertasSalida } from './salida.js';

function efectiva(modo: 'traspaso' | 'canal') {
  return resolverConfiguracion(
    validarConfiguracion({
      ...CONFIG_PRUEBA,
      operacion: { ...CONFIG_PRUEBA.operacion, contactoHumano: { ...CONFIG_PRUEBA.operacion?.contactoHumano, modo } },
      seguridad: { ...CONFIG_PRUEBA.seguridad, compuertasSalida: ['promete_traspaso'] },
    }),
    null,
  );
}

const PROMESAS = [
  'Le derivo con un asesor humano.',
  'Puedo derivarle con un asesor de Interseguros.',
  'Lo transfiero con una persona del equipo.',
  'Un asesor se pondrá en contacto con usted.',
  'Un asesor humano lo contactará pronto.',
  'Voy a pasar su consulta a un asesor.',
  'Su consulta pasa a una persona del equipo.',
  'Su conversación será derivada a un asesor.',
];
const LEGITIMAS = [
  'Puede escribir al WhatsApp de atención de Interseguros.',
  'Una persona de Interseguros atiende en horario hábil.',
  'En el paso 2 el sitio verifica su número de WhatsApp.',
  'Si el código no llega, espere un minuto y vuelva a pedirlo.',
  'Su consulta sobre el paso de pago se explica en el documento 14.',
];

describe('promete_traspaso', () => {
  it.each(PROMESAS)('en modo canal quita la promesa «%s» y agrega el canal', (frase) => {
    const c = efectiva('canal');
    const r = aplicarCompuertasSalida(`Eso se explica en el paso 3. ${frase}`, { config: c });
    expect(r.avisos).toContain('promete_traspaso');
    expect(r.texto).toContain('Eso se explica en el paso 3.');
    expect(r.texto).toContain(c.mensajes.derivacion);
    expect(r.texto).not.toContain(frase);
    expect(r.reemplazada).toBe(false);
  });

  it.each(LEGITIMAS)('no toca la respuesta legítima «%s»', (frase) => {
    const r = aplicarCompuertasSalida(frase, { config: efectiva('canal') });
    expect(r.avisos).not.toContain('promete_traspaso');
    expect(r.texto).toBe(frase);
  });

  it('en modo traspaso no hace nada', () => {
    const r = aplicarCompuertasSalida(PROMESAS[0]!, { config: efectiva('traspaso') });
    expect(r.texto).toBe(PROMESAS[0]);
  });

  it('no repite el canal si la respuesta ya lo trae', () => {
    const c = efectiva('canal');
    const r = aplicarCompuertasSalida(`Le derivo con un asesor. ${c.mensajes.derivacion}`, { config: c });
    expect(r.texto.split(c.mensajes.derivacion).length - 1).toBe(1);
  });
});

describe('herramienta derivar_humano según el modo', () => {
  it('en modo canal no manda a decir que la conversación pasa a una persona', async () => {
    const r = await INTERNAS['derivar_humano']!({ motivo: 'pide una persona' }, { config: efectiva('canal') } as never);
    expect(JSON.stringify(r.resultado)).toContain(INDICACION_DERIVAR.canal);
    expect(JSON.stringify(r.resultado)).not.toContain('pasa a una persona del equipo');
  });

  it('en modo traspaso conserva la indicación de siempre', async () => {
    const r = await INTERNAS['derivar_humano']!({ motivo: 'x' }, { config: efectiva('traspaso') } as never);
    expect(JSON.stringify(r.resultado)).toContain(INDICACION_DERIVAR.traspaso);
  });
});

describe('modo canal exige una vía de contacto', () => {
  it('se rechaza si no hay whatsapp, correo ni teléfono', () => {
    expect(() =>
      validarConfiguracion({ ...CONFIG_PRUEBA, operacion: { ...CONFIG_PRUEBA.operacion, contactoHumano: { modo: 'canal' } } }),
    ).toThrow(ErrorConfiguracion);
  });
});
