import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const raiz = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  resolve: {
    // Las pruebas corren sobre las fuentes, sin compilar antes.
    alias: {
      '@chatbotrag/nucleo': `${raiz}paquetes/nucleo/src/indice.ts`,
      '@chatbotrag/proveedor-vertex': `${raiz}paquetes/proveedor-vertex/src/indice.ts`,
      '@chatbotrag/conocimiento-gcs': `${raiz}paquetes/conocimiento-gcs/src/indice.ts`,
    },
  },
  test: {
    include: ['paquetes/**/src/**/*.prueba.ts', 'servicio/src/**/*.prueba.ts', 'scripts/**/*.prueba.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['paquetes/*/src/**/*.ts', 'servicio/src/**/*.ts'],
      exclude: ['**/*.prueba.ts', '**/indice.ts', '**/pruebas/**'],
      thresholds: { lines: 70, statements: 70 },
    },
  },
});
