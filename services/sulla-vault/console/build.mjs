// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

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
