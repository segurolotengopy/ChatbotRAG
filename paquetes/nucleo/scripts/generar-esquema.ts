// Genera esquemas/configuracion-agente.schema.json desde el esquema Zod.
// Se ejecuta con `pnpm esquema`; el archivo generado se versiona para que el
// panel y los editores lo consuman sin ejecutar TypeScript.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { esquemaConfiguracionAgente } from '../src/configuracion/esquema.js';

const destino = join(dirname(fileURLToPath(import.meta.url)), '..', 'esquemas', 'configuracion-agente.schema.json');
const esquema = z.toJSONSchema(esquemaConfiguracionAgente, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' });
const salida = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://chatbotrag/esquemas/configuracion-agente.schema.json',
  title: 'Configuración de agente ChatbotRAG (v1)',
  description: 'Documento JSON que describe un agente conversacional: identidad, voz, alcance, conocimiento (RAG), seguridad, herramientas, orientación, mensajes, modelo y perfiles.',
  ...esquema,
};
writeFileSync(destino, `${JSON.stringify(salida, null, 2)}\n`);
console.log(`Esquema escrito en ${destino}`);
