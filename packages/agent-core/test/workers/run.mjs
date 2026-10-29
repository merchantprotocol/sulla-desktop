// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs the golden transcripts on Cloudflare Workers (workerd via miniflare).

import { fileURLToPath } from 'node:url';

import { bundle, loadTool, report } from '../golden/tools.mjs';

const script = await bundle(fileURLToPath(new URL('./worker.js', import.meta.url)), { format: 'esm', platform: 'neutral' });
const { Miniflare } = await loadTool('miniflare');
const mf = new Miniflare({ modules: true, script, compatibilityDate: '2025-09-01' });
try {
  const res = await mf.dispatchFetch('http://golden.test/');
  report('workers', await res.json());
} finally {
  await mf.dispose();
}
