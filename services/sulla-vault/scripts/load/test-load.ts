// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { registerHooks } from 'node:module';

// The service and the stream path are Node code; only Electron module loading
// gets a test stub, so accidental Electron-session use fails closed.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'electron') return { url: new URL('./electron-stub.mjs', import.meta.url).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

// Keep stdout machine-readable: DesktopVaultTransport's route-selection line is diagnostic only.
const originalInfo = console.info.bind(console);
console.info = (...values) => process.stderr.write(`${ values.map(value => String(value)).join(' ') }\n`);

try {
  const { VaultLoadRunner } = await import('./LoadRunner.js');
  const runner = await VaultLoadRunner.fromArgs(process.argv.slice(2));
  await runner.run();
} catch (error) {
  const message = error instanceof Error ? error.message : 'Unknown harness failure';
  process.stderr.write(`Vault load harness failed: ${ message }\n`);
  process.exitCode = 1;
} finally {
  console.info = originalInfo;
}
