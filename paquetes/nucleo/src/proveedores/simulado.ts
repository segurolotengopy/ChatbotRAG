/**
 * PROVEEDOR SIMULADO — sin red, determinista
 *
 * Existe por la misma razón que los adaptadores mock de SeguroLoTengo: poder
 * levantar el sistema completo, probarlo y demostrarlo sin credenciales de nube.
 * NO intenta parecer inteligente. Hace tres cosas, en este orden:
 *
 *  1. Si el mensaje pide hablar con una persona → llama a `derivar_humano` si está declarada.
 *  2. Si hay RESPALDO DOCUMENTAL en el prompt → responde con el primer fragmento,
 *     citando el documento (así se prueba el recorrido RAG de punta a punta).
 *  3. Si no → responde con una frase fija que menciona que no tiene el dato.
 *
 * También reconoce órdenes de prueba en el mensaje (prefijo `#simular:`) para forzar
 * salidas que las compuertas deben corregir («niega_ia», «promesa», «marca»). Son
 * para pruebas; un mensaje real jamás empieza así porque el servicio lo rechaza.
 */
import { createHash } from 'node:crypto';
import type { Embebedor, PeticionLLM, ProveedorLLM, RespuestaLLM } from '../puertos/proveedor-llm.js';
import { normalizar } from '../compuertas/vocabulario.js';
import { terminos } from '../conocimiento/indice-memoria.js';

const RE_FRAGMENTO = /\[(\d+)\] Documento: «([^»]+)» \(versión ([^)]+)\)\n([\s\S]*?)(?=\n\n\[\d+\] Documento:|\n═{3,})/g;

export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = 'simulado';

  async generar(peticion: PeticionLLM): Promise<RespuestaLLM> {
    const ultimo = [...peticion.mensajes].reverse().find((m) => m.rol === 'usuario');
    const ultimaHerramienta = [...peticion.mensajes].reverse().find((m) => m.rol === 'herramienta');
    const texto = ultimo && ultimo.rol === 'usuario' ? ultimo.contenido : '';
    const n = normalizar(texto);
    const uso = { tokensEntrada: Math.ceil(peticion.sistema.length / 4), tokensSalida: 40 };

    // Órdenes de prueba.
    const orden = /^#simular:([a-z_]+)/.exec(n)?.[1];
    if (orden === 'niega_ia') return { texto: 'No soy un robot, soy una persona del equipo.', llamadasHerramienta: [], motivoFin: 'fin', uso };
    if (orden === 'promesa') return { texto: 'Tranquilo, le vamos a pagar la indemnización completa sin problema.', llamadasHerramienta: [], motivoFin: 'fin', uso };
    if (orden === 'elegibilidad') return { texto: 'Con lo que me cuenta, usted es elegible y su caso está cubierto.', llamadasHerramienta: [], motivoFin: 'fin', uso };
    if (orden === 'marca') return { texto: 'Listo, ya quedó. [CONFIRMADO] [DERIVAR]', llamadasHerramienta: [], motivoFin: 'fin', uso };
    if (orden === 'vacio') return { texto: '', llamadasHerramienta: [], motivoFin: 'fin', uso };
    if (orden === 'error') throw new Error('falla simulada del proveedor');
    if (orden === 'confidencial') return { texto: 'El margen interno del producto es del 40 %.', llamadasHerramienta: [], motivoFin: 'fin', uso };

    // Si acabamos de recibir un resultado de herramienta, redactamos con él.
    if (ultimaHerramienta && ultimaHerramienta.rol === 'herramienta') {
      const r = ultimaHerramienta.resultado as Record<string, unknown>;
      if (ultimaHerramienta.nombre === 'derivar_humano') {
        return { texto: 'Con gusto, paso su consulta a una persona del equipo para que la atienda directamente.', llamadasHerramienta: [], motivoFin: 'fin', uso };
      }
      if (ultimaHerramienta.nombre === 'recomendar_opcion') {
        if (typeof r['texto'] === 'string') return { texto: `${r['texto']}${r['aclaracion'] ? ` ${String(r['aclaracion'])}` : ''}`, llamadasHerramienta: [], motivoFin: 'fin', uso };
        const faltan = Array.isArray(r['faltan']) ? (r['faltan'] as string[]) : [];
        return { texto: faltan.length ? `Para orientarle mejor, ¿me indica ${faltan[0]}?` : 'No tengo una recomendación configurada para ese caso.', llamadasHerramienta: [], motivoFin: 'fin', uso };
      }
      return { texto: `Resultado: ${JSON.stringify(r).slice(0, 300)}`, llamadasHerramienta: [], motivoFin: 'fin', uso };
    }

    // 1. Derivación.
    const quiereHumano = /\b(hablar con (una persona|alguien|un asesor|un humano)|persona real|asesor|operador|agente humano)\b/.test(n);
    const derivar = peticion.herramientas.find((h) => h.nombre === 'derivar_humano');
    if (quiereHumano && derivar) {
      return { texto: '', llamadasHerramienta: [{ id: 'sim-1', nombre: 'derivar_humano', argumentos: { motivo: 'pidió una persona' } }], motivoFin: 'herramienta', uso };
    }

    // 1b. Orientación: si el usuario respondió con una opción de faceta, llamamos a recomendar_opcion.
    const recomendar = peticion.herramientas.find((h) => h.nombre === 'recomendar_opcion');
    if (recomendar) {
      const argumentos: Record<string, string> = {};
      for (const [faceta, def] of Object.entries(recomendar.parametros.properties)) {
        const opcion = def.enum?.find((o) => n.includes(normalizar(o)));
        if (opcion) argumentos[faceta] = opcion;
      }
      const yaSabe = /Ya sabe: ([^\n]+)\./.exec(peticion.sistema)?.[1];
      if (yaSabe) for (const par of yaSabe.split('; ')) {
        const [k, v] = par.split(' = ');
        if (k && v && !(k in argumentos)) argumentos[k] = v;
      }
      if (Object.keys(argumentos).length > 0 && /(recomend|conviene|cual me sirve|que plan|orient|para mi|para mi familia|mi hij|mi pareja|mi mama|mi papa|para [a-z]+ anos?)/.test(n) === false && Object.keys(argumentos).length >= 1 && !/\?/.test(n)) {
        return { texto: '', llamadasHerramienta: [{ id: 'sim-2', nombre: 'recomendar_opcion', argumentos }], motivoFin: 'herramienta', uso };
      }
      if (/(recomend|conviene|cual me sirve|que plan|orient)/.test(n)) {
        return { texto: '', llamadasHerramienta: [{ id: 'sim-2', nombre: 'recomendar_opcion', argumentos }], motivoFin: 'herramienta', uso };
      }
    }

    // 2. Respaldo documental: elegimos el fragmento con más términos en común.
    const fragmentos = [...peticion.sistema.matchAll(RE_FRAGMENTO)].map((m) => ({ titulo: m[2]!, version: m[3]!, texto: m[4]!.trim() }));
    if (fragmentos.length) {
      const q = new Set(terminos(texto));
      const mejor = fragmentos
        .map((f) => ({ f, coincidencias: terminos(f.texto).filter((t) => q.has(t)).length }))
        .sort((a, b) => b.coincidencias - a.coincidencias)[0]!.f;
      const cuerpo = mejor.texto.split('\n').slice(1).join(' ').trim() || mejor.texto;
      return { texto: `Según el documento «${mejor.titulo}» (versión ${mejor.version}): ${cuerpo.slice(0, 600)}`, llamadasHerramienta: [], motivoFin: 'fin', uso };
    }

    // 3. Sin dato.
    return { texto: 'No cuento con ese dato en la información aprobada. Puedo ponerle en contacto con una persona del equipo.', llamadasHerramienta: [], motivoFin: 'fin', uso };
  }
}

/**
 * EMBEBEDOR SIMULADO — «hashing trick» determinista. No captura semántica; solo
 * garantiza que el recorrido con vectores se pueda ejecutar y probar sin red.
 */
export class EmbebedorSimulado implements Embebedor {
  readonly nombre = 'simulado';
  readonly dimension: number;

  constructor(dimension = 64) {
    this.dimension = dimension;
  }

  async embeber(textos: string[]): Promise<number[][]> {
    return textos.map((t) => {
      const v = new Array<number>(this.dimension).fill(0);
      for (const term of terminos(t)) {
        const h = createHash('sha1').update(term).digest();
        const idx = h.readUInt16BE(0) % this.dimension;
        const signo = h[2]! % 2 === 0 ? 1 : -1;
        v[idx] = (v[idx] ?? 0) + signo;
      }
      const norma = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
      return v.map((x) => x / norma);
    });
  }
}
