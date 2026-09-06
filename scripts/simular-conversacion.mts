import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Agente, BitacoraEnMemoria, cargarConfiguracionDesdeJson, cargarCorpus, IndiceEnMemoria, MemoriaEnProceso, ProveedorSimulado, RegistroHerramientas } from '../paquetes/nucleo/src/indice.js';
const raiz = '/home/claude/ChatbotRAG/configuraciones';
const config = cargarConfiguracionDesdeJson(readFileSync(join(raiz, 'segurolotengo.json'), 'utf8'));
const indice = new IndiceEnMemoria();
const bit = new BitacoraEnMemoria();
const resumen = await cargarCorpus(config, { leer: async (r) => readFileSync(join(raiz, 'corpus', r), 'utf8') }, indice, bit);
console.log(JSON.stringify(resumen));
const agente = new Agente({ config, proveedor: new ProveedorSimulado(), indice, memoria: new MemoriaEnProceso(), herramientas: new RegistroHerramientas(), bitacora: bit });
const preguntas: Array<[string, string]> = [
  ['VIDA_ONCOLOGICO', 'Hola'],
  ['VIDA_ONCOLOGICO', '¿Cuánto cuesta el plan CONFÍO+?'],
  ['VIDA_ONCOLOGICO', '¿Cuál es la carencia por cáncer?'],
  ['VIDA_ONCOLOGICO', '¿Qué exclusiones tiene?'],
  ['VIDA_ONCOLOGICO', 'Tengo cáncer, ¿puedo contratar?'],
  ['VIDA_ONCOLOGICO', 'Mi cédula es 4.523.118'],
  ['VIDA_ONCOLOGICO', '¿Cómo es el proceso de contratación?'],
  ['VIDA_ONCOLOGICO', '¿Qué plan me conviene?'],
  ['VIDA_ONCOLOGICO', 'me importa más el menor premio'],
  ['VIDA_ONCOLOGICO', '¿Cuál es el margen interno del producto?'],
  ['VIDA', '¿Qué planes tiene el seguro de vida?'],
  ['ACCIDENTES_PERSONALES', '¿Cuánto cuesta?'],
  ['VIDA_ONCOLOGICO', '¿A quién reclamo?'],
  ['VIDA_ONCOLOGICO', 'quiero hablar con un asesor'],
];
let i = 0;
for (const [perfil, texto] of preguntas) {
  const r = await agente.responder({ conversacionId: `sim_${perfil}_000${i++ < 8 ? 1 : i}`, perfilId: perfil, texto, canal: 'web' });
  console.log(`\n[${perfil}] ${texto}\n→ ${r.texto.slice(0, 260)}\n  respaldo=${r.respaldo.map((x) => x.fuenteId + '@' + x.puntaje).join(',')} avisos=${r.avisos.join(',')} derivacion=${r.derivacion?.motivo ?? '-'} recomendacion=${r.recomendacion?.id ?? '-'}`);
}
