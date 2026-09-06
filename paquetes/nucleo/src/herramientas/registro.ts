/**
 * REGISTRO DE HERRAMIENTAS
 *
 * Une las internas del núcleo con un `EjecutorHerramientas` externo (el servicio,
 * para las `http`). También valida al cargar que toda herramienta `interna`
 * declarada exista: un nombre desconocido es un error de configuración, no un
 * fallo en producción.
 */
import type { ConfiguracionAgente, ConfiguracionEfectiva, Herramienta } from '../configuracion/esquema.js';
import { resolverConfiguracion } from '../configuracion/perfiles.js';
import type { ContextoHerramienta, EjecutorHerramientas, ResultadoHerramienta } from '../puertos/herramienta.js';
import { INTERNAS } from './internas.js';

export class ErrorHerramienta extends Error {
  constructor(mensaje: string) {
    super(mensaje);
    this.name = 'ErrorHerramienta';
  }
}

export function validarHerramientas(config: ConfiguracionAgente): string[] {
  const problemas: string[] = [];
  const revisar = (lista: Herramienta[], ruta: string) => {
    const nombres = new Set<string>();
    for (const h of lista) {
      if (nombres.has(h.nombre)) problemas.push(`${ruta}: herramienta duplicada «${h.nombre}»`);
      nombres.add(h.nombre);
      if (h.tipo === 'interna' && !(h.nombre in INTERNAS)) problemas.push(`${ruta}: no existe la herramienta interna «${h.nombre}» (disponibles: ${Object.keys(INTERNAS).join(', ')})`);
    }
  };
  revisar(config.herramientas, 'herramientas');
  for (const id of Object.keys(config.perfiles)) revisar(resolverConfiguracion(config, id).herramientas, `perfiles.${id}.herramientas`);
  return problemas;
}

export class RegistroHerramientas implements EjecutorHerramientas {
  constructor(private readonly externo: EjecutorHerramientas | null = null) {}

  async ejecutar(nombre: string, argumentos: Record<string, unknown>, contexto: ContextoHerramienta): Promise<ResultadoHerramienta> {
    const declarada = contexto.config.herramientas.find((h) => h.nombre === nombre);
    if (!declarada) throw new ErrorHerramienta(`El modelo invocó una herramienta no declarada: ${nombre}`);
    if (declarada.tipo === 'interna') {
      const fn = INTERNAS[nombre];
      if (!fn) throw new ErrorHerramienta(`Herramienta interna desconocida: ${nombre}`);
      return fn(argumentos, contexto);
    }
    if (!this.externo) throw new ErrorHerramienta(`No hay ejecutor externo para la herramienta http «${nombre}»`);
    return this.externo.ejecutar(nombre, argumentos, contexto);
  }

  static declaradas(config: ConfiguracionEfectiva): Herramienta[] {
    return config.herramientas;
  }
}
