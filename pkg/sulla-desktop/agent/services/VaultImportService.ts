// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Container-owned, idempotent legacy migration trigger. */
import { createHash } from 'node:crypto';

import { DesktopVaultClient, getDesktopVaultClient } from './DesktopVaultClient';

export class VaultImportService {
  constructor(private readonly client: () => DesktopVaultClient = () => getDesktopVaultClient()) {}

  /** Deterministic UUID-shaped id for a legacy account. Pure: the same inputs always give the same id. */
  static legacyAccountItemId(integrationId: string, accountId: string): string {
    const hex = createHash('sha256').update(`sulla-legacy-account-v2:${ integrationId }:${ accountId }`).digest('hex').slice(0, 32);
    return `${ hex.slice(0, 8) }-${ hex.slice(8, 12) }-5${ hex.slice(13, 16) }-8${ hex.slice(17, 20) }-${ hex.slice(20) }`;
  }

  /** Password is intentionally ignored; no human secret may cross Desktop IPC. */
  async importLegacyCredentials(_masterPassword?: string): Promise<void> {
    await this.client().migrate();
  }
}

/** The process-wide import trigger. It holds no state of its own. */
export const vaultImports = new VaultImportService();
