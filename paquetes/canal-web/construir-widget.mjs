// Empaqueta el widget como un único archivo IIFE para incluirlo con <script>.
import { build } from 'esbuild';
await build({
  entryPoints: ['src/widget.ts'],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  outfile: 'dist-web/chatbotrag-widget.js',
  legalComments: 'none',
});
console.log('widget → dist-web/chatbotrag-widget.js');
