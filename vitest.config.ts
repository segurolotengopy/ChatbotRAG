import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['paquetes/**/src/**/*.prueba.ts', 'servicio/src/**/*.prueba.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['paquetes/*/src/**/*.ts', 'servicio/src/**/*.ts'],
      exclude: ['**/*.prueba.ts', '**/indice.ts', '**/tipos.ts'],
      thresholds: { lines: 70, statements: 70 },
    },
  },
});
