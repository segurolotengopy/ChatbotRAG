// Superficie pública del núcleo. Todo lo que el servicio, los adaptadores y las
// pruebas necesitan sale de acá; nada importa rutas internas.
export * from './configuracion/esquema.js';
export * from './configuracion/cargar.js';
export * from './configuracion/perfiles.js';
export * from './configuracion/derivados.js';
export * from './puertos/indice.js';
export * from './compuertas/saneo.js';
export * from './compuertas/cortesia.js';
export * from './compuertas/entrada.js';
export * from './compuertas/salida.js';
export { normalizar } from './compuertas/vocabulario.js';
export * from './prompt/armar.js';
export * from './prompt/frases.js';
export * from './conocimiento/trocear.js';
export * from './conocimiento/indice-memoria.js';
export * from './conocimiento/cargar-corpus.js';
export * from './memoria/memoria-en-proceso.js';
export * from './herramientas/internas.js';
export * from './herramientas/registro.js';
export * from './orquestador/agente.js';
export * from './proveedores/simulado.js';
export * from './bitacora/bitacora-consola.js';
