// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentPolicy, VaultItemPlaintext } from '@sulla/vault-crypto';

import { CloudSyncError } from './CloudSyncError.js';

/** Validates the decrypted body of a record pulled from Cloud before any of it is stored. */
export class RemoteItemParser {
  private readonly itemTypes = new Set(['login', 'note', 'card', 'identity', 'apiKey']);

  parse(json: string): VaultItemPlaintext {
    const item = JSON.parse(json) as VaultItemPlaintext;
    const policy = item?.agentPolicy as AgentPolicy | undefined;
    if (!item || typeof item.name !== 'string' || !item.name.trim() || !this.itemTypes.has(item.type) || !policy ||
        !['only_me', 'agents'].includes(policy.mode) || !['metadata', 'autofill', 'full'].includes(policy.level) ||
        !Array.isArray(policy.sites) || !Array.isArray(policy.agents)) {
      throw new CloudSyncError('remote_item_invalid', 422, 'A Cloud item failed validation');
    }
    return item;
  }
}
