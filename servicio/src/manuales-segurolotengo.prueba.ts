/**
 * MANUALES DE PANTALLA DE SEGUROLOTENGO, DE PUNTA A PUNTA CON LA CONFIGURACIÓN REAL
 *
 * Las pruebas de `nucleo` usan un corpus de juguete. Esta carga el corpus REAL que se
 * despliega (los 21 manuales de `corpus/segurolotengo/manuales/`) en un índice en
 * memoria y comprueba que el contexto de página selecciona el manual correcto del perfil
 * con producto disponible. Si una ruta o un `fuenteId` de `paginas` se rompe, el asistente
 * respondería sin la pantalla y ninguna otra prueba lo notaría.
 *
 * Qué NO garantiza: que el modelo cite bien el manual. Con el proveedor simulado solo se
 * mide qué respaldo se arma, no qué dice el modelo real.
 */
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  Agente,
  BitacoraEnMemoria,
  cargarConfiguracionDesdeJson,
  cargarCorpus,
  IndiceEnMemoria,
  MemoriaEnProceso,
  ProveedorSimulado,
  RegistroHerramientas,
} from '@chatbotrag/nucleo';
import type { PeticionLLM } from '@chatbotrag/nucleo';

const CONFIG = new URL('../../configuraciones/segurolotengo.json', import.meta.url);
const CORPUS = new URL('../../configuraciones/corpus/', import.meta.url);
const config = cargarConfiguracionDesdeJson(readFileSync(CONFIG, 'utf8'));

let contador = 0;
const sistemas: string[] = [];
async function armar() {
  const bitacora = new BitacoraEnMemoria();
  const simulado = new ProveedorSimulado();
  const indice = new IndiceEnMemoria(null);
  await cargarCorpus(config, { leer: (ruta: string) => readFile(new URL(ruta, CORPUS), 'utf8') }, indice, bitacora);
  const agente = new Agente({
    config,
    proveedor: {
      nombre: 'simulado-espia',
      generar: (p: PeticionLLM) => {
        sistemas.push(p.sistema);
        return simulado.generar(p);
      },
    },
    indice,
    memoria: new MemoriaEnProceso(),
    herramientas: new RegistroHerramientas(),
    bitacora,
    reloj: () => new Date('2026-10-25T14:00:00Z'),
  });
  return { agente };
}
const idConv = () => `conv_manual_${String(++contador).padStart(4, '0')}`;

describe('manuales de pantalla con el corpus real', () => {
  it('declara las 21 páginas y cada una apunta a su manual', () => {
    const paginas = config.perfiles['VIDA_ONCOLOGICO']?.conocimiento?.paginas ?? [];
    expect(paginas).toHaveLength(21);
    for (const p of paginas) expect(p.fuenteId).toBe(`manual-${p.id}`);
  });

  it('pagina «plan» trae manual-plan con origen «pagina» y el precio tal como lo muestra la pantalla', async () => {
    sistemas.length = 0;
    const { agente } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'plan', canal: 'web' });
    expect(r.respaldo[0]).toMatchObject({ fuenteId: 'manual-plan', origen: 'pagina' });
    expect(r.avisos).not.toContain('pagina_desconocida');
    expect(r.avisos).not.toContain('sin_respaldo');
    expect(sistemas[0]).toContain('390.000');
  });

  it('pagina «firma» trae manual-firma', async () => {
    const { agente } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'firma', canal: 'web' });
    expect(r.respaldo[0]).toMatchObject({ fuenteId: 'manual-firma', origen: 'pagina' });
  });

  it('una página inexistente da pagina_desconocida', async () => {
    const { agente } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: '¿Qué hago acá?', pagina: 'no-existe', canal: 'web' });
    expect(r.avisos).toContain('pagina_desconocida');
    expect(r.respaldo.some((x) => x.origen === 'pagina')).toBe(false);
  });

  // Con el corpus real y el embebedor simulado, «tasa de interés del crédito hipotecario» SÍ trae un
  // acierto débil (puntaje 0,3129 contra umbral 0,3) del manual de preparación: el índice simulado
  // es léxico y ruidoso. Por eso la pregunta de prueba es otra; con embeddings reales no aplica.
  it('una pregunta ajena, sin deíctico y sin coincidencia, cae en sin_respaldo aunque la página sea válida', async () => {
    const { agente } = await armar();
    const r = await agente.responder({ conversacionId: idConv(), texto: 'cuál es la capital de Francia', pagina: 'plan', canal: 'web' });
    expect(r.avisos).toContain('sin_respaldo');
    expect(r.respaldo).toEqual([]);
  });
});
