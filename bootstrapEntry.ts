// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { app } from 'electron';
import { isDefaultServiceNamespace, namespacedAppPath } from '@pkg/utils/serviceNamespace';

// Namespace must be applied before importing the normal main graph: Electron's
// single-instance lock, Cookies, Local Storage and fallback settings all derive
// from userData. Production keeps its historical path byte-for-byte.
if (!isDefaultServiceNamespace) app.setPath('userData', namespacedAppPath(app.getPath('userData')));

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
  void import('./background');
}
