// Copyright © 2026 Merchant Protocol, LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

// Server-mode vault origin (/cloud-vault-sync/* on vault.<host>) and the
// server-providers system collection. See README.md in this folder.

export { loadBrowserSyncConfig, type BrowserSyncConfig } from './config.js';
export { createVaultOrigin } from './origin.js';
export { createServerProvidersRouter } from './providers.js';
export { createBrowserSyncRouter } from './routes.js';
