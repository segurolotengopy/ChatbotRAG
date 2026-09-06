// Reglas del repositorio. La más importante es la frontera de nube: nada fuera de
// `paquetes/proveedor-*` y `paquetes/conocimiento-*` puede importar un SDK de Google
// o Amazon. Es la misma regla que en segurolotengo-demo, y por la misma razón: el
// núcleo tiene que poder cambiar de nube sin tocar una línea.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const SDKS_DE_NUBE = [
  { name: '@google/genai', message: 'Los SDK de nube viven en paquetes/proveedor-*.' },
  { name: '@google-cloud/vertexai', message: 'Los SDK de nube viven en paquetes/proveedor-*.' },
  { name: '@aws-sdk/client-bedrock-runtime', message: 'Los SDK de nube viven en paquetes/proveedor-*.' },
  { name: 'pg', message: 'El acceso a PostgreSQL vive en paquetes/conocimiento-pgvector.' },
];

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'coverage/**', 'integraciones/**', 'paquetes/canal-web/dist-web/**'] },
  js.configs.recommended,
  { files: ['**/*.mjs', '**/*.js'], languageOptions: { globals: { console: 'readonly', process: 'readonly' } } },
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-imports': ['error', { paths: SDKS_DE_NUBE }],
    },
  },
  {
    files: ['paquetes/proveedor-*/src/**/*.ts', 'paquetes/conocimiento-*/src/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
  {
    files: ['paquetes/nucleo/src/**/*.ts'],
    rules: { 'no-restricted-globals': ['error', { name: 'fetch', message: 'El núcleo no habla con la red.' }] },
  },
);
