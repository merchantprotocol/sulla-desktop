// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { app } from 'electron';

import { e2eTrace, installE2eCrashTrace } from '@pkg/main/e2eTrace';

installE2eCrashTrace();
e2eTrace(`bootstrap start platform=${ process.platform } argv=${ JSON.stringify(process.argv.slice(1)) }`);

// The bootstrap helper branch executes before importing any normal Desktop
// modules, IPC handlers, browser registries, agent services, or logging.
const filesBootstrapHelper = process.argv.includes('--sulla-files-bootstrap-helper');
const vaultBootstrapHelper = process.argv.includes('--sulla-vault-bootstrap-helper') ||
  process.argv.includes('--sulla-vault-cache-update-helper');

// These helpers reuse the signed Electron executable so safeStorage retains
// its macOS Keychain identity. Keep them out of the Dock before app readiness;
// hiding the Dock icon after whenReady() is too late and causes a visible flash.
if (process.platform === 'darwin' && (filesBootstrapHelper || vaultBootstrapHelper)) {
  app.setActivationPolicy('accessory');
}

if (filesBootstrapHelper) {
  void import('@pkg/main/sullaFilesBootstrapProcess').then(module => module.runSullaFilesBootstrapProcess());
} else if (vaultBootstrapHelper) {
  void import('@pkg/main/vaultBootstrapProcess').then(module => module.runVaultBootstrapProcess());
} else {
  void import('./background').then(
    () => e2eTrace('background module loaded'),
    (error) => {
      e2eTrace(`background module failed to load: ${ error instanceof Error ? error.stack : error }`);
      throw error;
    },
  );
}
