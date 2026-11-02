// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PendingCredential } from '@pkg/main/firstRun/pendingCredentials';
import { getConfiguredApprovalClient } from '@pkg/vault-broker';

/** One authority call; the caller clears memory only after it resolves. */
export async function promoteMemoryCredentialToVault(entry: PendingCredential): Promise<void> {
  const client = getConfiguredApprovalClient();
  if (!client) throw new Error('Desktop vault session service is unavailable');
  await client.importIntegrationAccount(entry.integrationId, { accountId: entry.accountId, label: entry.values.account_label, values: entry.values, active: entry.activate !== false, connected: entry.activate !== false });
}
