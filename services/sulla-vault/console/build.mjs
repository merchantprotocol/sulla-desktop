import { build } from 'esbuild';
import { resolve } from 'node:path';

await build({
  entryPoints: [resolve('console/app.ts')],
  outfile: resolve('console/app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
});
