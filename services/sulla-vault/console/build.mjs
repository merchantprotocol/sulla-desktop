import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(here, 'app.ts')],
  outfile: resolve(here, 'app.js'),
  bundle: true,
  alias: { '@sulla/vault-crypto': resolve(here, '../../../packages/vault-crypto/src/index.ts') },
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  sourcemap: false,
});
