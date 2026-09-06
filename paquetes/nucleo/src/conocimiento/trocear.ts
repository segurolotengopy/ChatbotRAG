/**
 * TROCEADO DE DOCUMENTOS
 *
 * Divide Markdown o texto plano en fragmentos de tamaño acotado, respetando
 * párrafos y encabezados. Cada fragmento lleva la ruta de encabezados que lo
 * contiene («Coberturas › Carencias») para que el modelo y la persona sepan de
 * qué sección sale. Determinista: el mismo documento produce los mismos ids.
 */
import { createHash } from 'node:crypto';
import type { Fragmento } from '../puertos/indice-conocimiento.js';

export interface DocumentoFuente {
  fuenteId: string;
  titulo: string;
  version: string;
  coleccion: string;
  texto: string;
}

export interface OpcionesTroceado {
  tamano: number;
  solapamiento: number;
}

interface Bloque {
  encabezados: string[];
  texto: string;
}

function bloques(texto: string): Bloque[] {
  const lineas = texto.replace(/\r\n?/g, '\n').split('\n');
  const salida: Bloque[] = [];
  const pila: string[] = [];
  let actual: string[] = [];
  const cerrar = () => {
    const cuerpo = actual.join('\n').trim();
    if (cuerpo) salida.push({ encabezados: [...pila], texto: cuerpo });
    actual = [];
  };
  for (const linea of lineas) {
    const m = /^(#{1,6})\s+(.+)$/.exec(linea);
    if (m) {
      cerrar();
      const nivel = m[1]!.length;
      pila.length = Math.max(0, nivel - 1);
      pila[nivel - 1] = m[2]!.trim();
      continue;
    }
    if (linea.trim() === '' && actual.length && actual[actual.length - 1]!.trim() === '') continue;
    actual.push(linea);
  }
  cerrar();
  return salida;
}

function partirLargo(texto: string, tamano: number, solapamiento: number): string[] {
  if (texto.length <= tamano) return [texto];
  const partes: string[] = [];
  let inicio = 0;
  while (inicio < texto.length) {
    let fin = Math.min(texto.length, inicio + tamano);
    if (fin < texto.length) {
      // Cortar en el último punto o salto de línea dentro de la ventana.
      const corte = Math.max(texto.lastIndexOf('. ', fin), texto.lastIndexOf('\n', fin));
      if (corte > inicio + tamano * 0.5) fin = corte + 1;
    }
    partes.push(texto.slice(inicio, fin).trim());
    if (fin >= texto.length) break;
    inicio = Math.max(fin - solapamiento, inicio + 1);
  }
  return partes.filter((p) => p.length > 0);
}

export function trocear(doc: DocumentoFuente, opciones: OpcionesTroceado): Fragmento[] {
  const fragmentos: Fragmento[] = [];
  let acumulado: { encabezados: string[]; textos: string[] } | null = null;
  const volcar = () => {
    if (!acumulado) return;
    const prefijo = acumulado.encabezados.length ? `${acumulado.encabezados.join(' › ')}\n` : '';
    const cuerpo = acumulado.textos.join('\n\n');
    for (const parte of partirLargo(cuerpo, opciones.tamano - prefijo.length, opciones.solapamiento)) {
      const texto = `${prefijo}${parte}`;
      const orden = fragmentos.length;
      const id = createHash('sha256').update(`${doc.coleccion}|${doc.fuenteId}|${doc.version}|${orden}|${texto}`).digest('hex').slice(0, 24);
      fragmentos.push({ id, coleccion: doc.coleccion, fuenteId: doc.fuenteId, fuenteTitulo: doc.titulo, fuenteVersion: doc.version, orden, texto });
    }
    acumulado = null;
  };
  for (const b of bloques(doc.texto)) {
    const mismaSeccion = acumulado && acumulado.encabezados.join('›') === b.encabezados.join('›');
    const largoActual = acumulado ? acumulado.textos.join('\n\n').length : 0;
    if (mismaSeccion && acumulado && largoActual + b.texto.length + 2 <= opciones.tamano) {
      acumulado.textos.push(b.texto);
    } else {
      volcar();
      acumulado = { encabezados: b.encabezados, textos: [b.texto] };
    }
  }
  volcar();
  return fragmentos;
}
