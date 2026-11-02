// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { usesContainerVaultAuthority } from '@pkg/vault-broker';
import { FirstRunMemoryCustody } from './FirstRunMemoryCustody';
import { LegacyDbCustody } from './LegacyDbCustody';
import type { ResolvedTokenCustody } from './TokenCustody';
import { VaultCustody } from './VaultCustody';

export class CustodyResolver {
  private readonly memory = new FirstRunMemoryCustody();
  private readonly vault = new VaultCustody();
  private readonly legacy = new LegacyDbCustody();
  resolve(options: { firstRun?: boolean } = {}): ResolvedTokenCustody {
    if (options.firstRun) return this.memory;
    return usesContainerVaultAuthority() ? this.vault : this.legacy;
  }
}
