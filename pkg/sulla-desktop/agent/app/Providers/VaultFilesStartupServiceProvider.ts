// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { VaultFilesStartup } from '../../../main/VaultFilesStartup';

/** Owns the application-scoped Vault + Files startup state used by lifecycle consumers. */
export class VaultFilesStartupServiceProvider {
  readonly startup: VaultFilesStartup;

  constructor(startup = new VaultFilesStartup()) {
    this.startup = startup;
  }
}

export const vaultFilesStartupProvider = new VaultFilesStartupServiceProvider();
