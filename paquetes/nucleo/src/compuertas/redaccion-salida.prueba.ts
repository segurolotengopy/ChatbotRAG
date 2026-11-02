/**
 * PRUEBA DE LA REDACCIÓN DE PAN, CVV Y OTP EN LA SALIDA (P17)
 *
 * Se prueban las dos direcciones: que el dato se borre dejando el resto intacto y que
 * montos, teléfonos, fechas, cédulas y pólizas NO se toquen.
 *
 * Qué NO garantiza: solo cubre los casos listados; ver los límites en `redaccion-salida.ts`.
 */
import { describe, expect, it } from 'vitest';
import { validarConfiguracion } from '../configuracion/cargar.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import { CONFIG_PRUEBA } from '../pruebas/configuracion-prueba.js';
import { MARCADOR_DATO_ELIMINADO, redactarDatosDePago } from './redaccion-salida.js';
import { aplicarCompuertasSalida } from './salida.js';

const ancho = (s: string) => s.replace(/\d/g, (d) => String.fromCodePoint(0xff10 + Number(d)));

const SE_BORRAN: Array<[string, string]> = [
  ['Su tarjeta 4111 1111 1111 1111 quedó.', 'Su tarjeta (dato eliminado) quedó.'],
  ['Su tarjeta 4111-1111-1111-1111 quedó.', 'Su tarjeta (dato eliminado) quedó.'],
  ['Su tarjeta 4111111111111111 quedó.', 'Su tarjeta (dato eliminado) quedó.'],
  ['Su tarjeta 4111\u00a01111\u00a01111\u00a01111 quedó.', 'Su tarjeta (dato eliminado) quedó.'],
  ['Su tarjeta 4111\n1111 1111 1111 quedó.', 'Su tarjeta (dato eliminado) quedó.'],
  ['Tarjeta 4111 1111 1111 1111 12/28 anotada.', 'Tarjeta (dato eliminado) 12/28 anotada.'],
  ['Tarjeta 4111 1111 1111 1111 123 anotada.', 'Tarjeta (dato eliminado) 123 anotada.'],
  ['Tarjeta 4111111111111111 123.', 'Tarjeta (dato eliminado) 123.'],
  ['Amex 378282246310005 anotada.', 'Amex (dato eliminado) anotada.'],
  [`Número ${ancho('4111 1111 1111 1111')} anotado.`, 'Número (dato eliminado) anotado.'],
  ['CVV 123 anotado.', 'CVV (dato eliminado) anotado.'],
  ['El 123 es el CVV.', 'El (dato eliminado) es el CVV.'],
  ['Código de seguridad: 4567 listo.', 'Código de seguridad: (dato eliminado) listo.'],
  ['Los números de atrás son 321 gracias.', 'Los números de atrás son (dato eliminado) gracias.'],
  ['El código de verificación 482913 llegó.', 'El código de verificación (dato eliminado) llegó.'],
  ['482913 es su código de verificación.', '(dato eliminado) es su código de verificación.'],
  ['Su OTP es 48 29 13 hoy.', 'Su OTP es (dato eliminado) hoy.'],
  ['El token 4829 sirve.', 'El token (dato eliminado) sirve.'],
];

const NO_SE_TOCAN = [
  'Gs 12.500.000',
  'USD 1,500.00',
  '0981 123 456',
  '+595 21 123 4567',
  '19-10-2026',
  '12/28',
  'Cédula 4.523.118',
  'Cédula 4523118',
  'Póliza 2026-004512',
  'año 2026',
  '4111 1111 1111 1112',
  'código de reserva 482913',
  'código postal 1209',
  'código de póliza 12345678',
  'ingrese el código de 6 dígitos',
  'el CVV son los 3 dígitos del reverso',
  'termina en 1111',
  'Nunca le pediremos el CVV. Su póliza 1234 vence pronto.',
  'Desde 2026 Bancard exige el CVV.',
  'Póliza 2026, CVV: no lo pedimos.',
  'Si no recibió el código por SMS, llame al 021 123 4567.',
  'El token vence en 300 segundos; llame al 0800 11 2233.',
  'Su código de verificación llegó el 19-10-2026.',
  'código de verificación del trámite: vence en 2026',
  'Use el token del banco antes del 2026',
  'otp 123 456 789',
  'cvv 123 456',
];

describe('redactarDatosDePago', () => {
  it.each(SE_BORRAN)('borra el dato y deja el resto: %s', (entrada, esperado) => {
    const r = redactarDatosDePago(entrada);
    expect(r.texto).toBe(esperado);
    expect(r.texto).toContain(MARCADOR_DATO_ELIMINADO);
    expect(r.redactados).toBeGreaterThan(0);
  });

  it.each(NO_SE_TOCAN)('no toca: %s', (entrada) => {
    const r = redactarDatosDePago(entrada);
    expect(r.texto).toBe(entrada);
    expect(r.redactados).toBe(0);
  });

  it('un número vecino no deja parte del PAN a la vista', () => {
    expect(redactarDatosDePago('llame al 6 4111 1111 1111 1111 gracias').texto).not.toContain('1111');
    expect(redactarDatosDePago('x 1608 4564 8447 6344 2614 928 y').texto).not.toContain('2614');
  });

  it('dos rangos contiguos dan un solo marcador', () => {
    const r = redactarDatosDePago('CVV 123 ' + 'x');
    expect(r.redactados).toBe(1);
    const dos = redactarDatosDePago('4111 1111 1111 1111 5500 0000 0000 0004');
    expect(dos.texto).not.toMatch(/\d/);
  });

  it('propiedad: ningún grupo de 4 dígitos del PAN sobrevive con vecinos numéricos', () => {
    let semilla = 20261023;
    const azar = (n: number) => {
      semilla = (Math.imul(semilla, 1664525) + 1013904223) >>> 0;
      return semilla % n;
    };
    const digitos = (n: number) => Array.from({ length: n }, () => String(azar(10))).join('');
    const luhn = (base: string) => {
      for (let c = 0; c < 10; c++) {
        const d = base + String(c);
        let suma = 0;
        for (let i = d.length - 1, doble = false; i >= 0; i--, doble = !doble) {
          let x = Number(d[i]);
          if (doble) x = x * 2 > 9 ? x * 2 - 9 : x * 2;
          suma += x;
        }
        if (suma % 10 === 0) return d;
      }
      throw new Error('inalcanzable');
    };
    for (let it = 0; it < 2000; it++) {
      const largo = 13 + azar(7);
      const pan = luhn(String(1 + azar(9)) + digitos(largo - 2));
      const antes = Array.from({ length: azar(3) }, () => digitos(1 + azar(6)));
      const despues = Array.from({ length: azar(3) }, () => digitos(1 + azar(6)));
      const escrito = pan.replace(/(\d{4})(?=\d)/g, '$1 ');
      const texto = ['x', ...antes, escrito, ...despues, 'y'].join(' ');
      const cuartetos = Array.from({ length: pan.length - 3 }, (_, i) => pan.slice(i, i + 4));
      // Un vecino que contenga por azar un cuarteto del PAN invalidaría la comprobación: se omite.
      if ([...antes, ...despues].some((v) => cuartetos.some((c) => v.includes(c)))) continue;
      const restantes = redactarDatosDePago(texto).texto.split(/\D+/);
      for (const c of cuartetos) {
        expect(restantes.some((t) => t.includes(c)), texto).toBe(false);
      }
    }
  });

  it('rinde en un texto largo (sin costo cuadrático)', () => {
    const largo = 'cvv 123 '.repeat(4000);
    const t0 = performance.now();
    const r = redactarDatosDePago(largo);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(r.texto).not.toContain('123');
  });

  it('un PAN y su CVV juntos se borran por separado y la póliza sobrevive', () => {
    const r = redactarDatosDePago('Su tarjeta 4111 1111 1111 1111, CVV 123, póliza 2026-004512.');
    expect(r.texto).toBe('Su tarjeta (dato eliminado), CVV (dato eliminado), póliza 2026-004512.');
    expect(r.redactados).toBe(2);
  });
});

function efectiva(compuertasSalida: string[]) {
  return resolverConfiguracion(
    validarConfiguracion({ ...CONFIG_PRUEBA, seguridad: { ...CONFIG_PRUEBA.seguridad, compuertasSalida } as never }),
    null,
  );
}

describe('aplicarCompuertasSalida con dato_tarjeta_codigo', () => {
  it('corre siempre, aunque la configuración no la liste', () => {
    const r = aplicarCompuertasSalida('Su tarjeta 4111 1111 1111 1111 quedó.', { config: efectiva([]) });
    expect(r.texto).toBe('Su tarjeta (dato eliminado) quedó.');
    expect(r.avisos).toEqual(['dato_tarjeta_codigo']);
    expect(r.reemplazada).toBe(false);
  });

  it('el marcador sobrevive a marca_no_declarada', () => {
    const r = aplicarCompuertasSalida('Listo [CONFIRMADO] con 4111 1111 1111 1111.', { config: efectiva([]) });
    expect(r.texto).toContain(MARCADOR_DATO_ELIMINADO);
    expect(r.avisos).toContain('dato_tarjeta_codigo');
  });

  it('con una promesa de indemnización y un PAN: ambos avisos y texto fijo', () => {
    const config = efectiva(['promesa_indemnizacion']);
    const r = aplicarCompuertasSalida('Le vamos a pagar la indemnización. Tarjeta 4111 1111 1111 1111.', { config });
    expect(r.avisos).toContain('dato_tarjeta_codigo');
    expect(r.avisos).toContain('promesa_indemnizacion');
    expect(r.reemplazada).toBe(true);
    expect(r.texto).toBe(`${config.mensajes.fueraDeAlcance} ${config.mensajes.derivacion}`.trim());
  });
});
