// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Runs the golden transcripts on the Hermes engine React Native uses.
// HERMES_BIN points at the `hermes` CLI. esbuild lowers the bundle to
// ES2016 syntax (React Native apps are transpiled by Metro/Babel too); no
// runtime polyfills are added.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundle, report } from '../golden/tools.mjs';

const hermes = process.env.HERMES_BIN;
if (!hermes) {
  console.error('Set HERMES_BIN to the hermes CLI binary.');
  process.exit(1);
}

const code = await bundle(fileURLToPath(new URL('./entry.js', import.meta.url)), { format: 'iife', platform: 'neutral', target: 'es2016' });
const dir = mkdtempSync(join(tmpdir(), 'agent-core-hermes-'));
try {
  const file = join(dir, 'golden.js');
  writeFileSync(file, code);
  const out = execFileSync(hermes, [file], { encoding: 'utf8' });
  const line = out.split('\n').find(l => l.startsWith('GOLDEN_RESULT ') || l.startsWith('GOLDEN_ERROR '));
  if (!line || line.startsWith('GOLDEN_ERROR ')) {
    console.error(out);
    process.exit(1);
  }
  report('hermes', JSON.parse(line.slice('GOLDEN_RESULT '.length)));
} finally {
  rmSync(dir, { recursive: true, force: true });
}
