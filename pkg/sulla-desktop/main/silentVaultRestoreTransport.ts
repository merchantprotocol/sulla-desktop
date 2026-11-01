// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { VaultBrokerFetch } from './index';

/** Retry a locked broker request once after restoring its opaque session. */
export function withSilentVaultRestore(fetcher: VaultBrokerFetch, restore: () => Promise<boolean>): VaultBrokerFetch {
  let restoring: Promise<boolean> | undefined;

  return async(input, init) => {
    const response = await fetcher(input, init);

    if (response.status !== 423) return response;
    restoring ??= restore().finally(() => { restoring = undefined });
    if (!await restoring) return response;
    await response.body?.cancel();

    return fetcher(input, init);
  };
}
