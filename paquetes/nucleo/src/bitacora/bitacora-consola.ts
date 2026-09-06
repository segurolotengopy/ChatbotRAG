/**
 * BITÁCORA A CONSOLA — una línea JSON por evento (Cloud Logging / CloudWatch la
 * indexan tal cual). Sin texto de mensajes por contrato del puerto; además, por
 * defensa en profundidad, `detalle` se recorta a 200 caracteres.
 */
import type { Bitacora, EventoBitacora } from '../puertos/bitacora.js';

export class BitacoraConsola implements Bitacora {
  constructor(private readonly salida: (linea: string) => void = (l) => console.log(l)) {}

  registrar(evento: EventoBitacora): void {
    const seguro: EventoBitacora & { en: string } = { ...evento, en: new Date().toISOString() };
    if (seguro.detalle) seguro.detalle = seguro.detalle.slice(0, 200);
    this.salida(JSON.stringify(seguro));
  }
}

/** Bitácora que acumula en memoria; para pruebas. */
export class BitacoraEnMemoria implements Bitacora {
  readonly eventos: EventoBitacora[] = [];
  registrar(evento: EventoBitacora): void {
    this.eventos.push(evento);
  }
}
