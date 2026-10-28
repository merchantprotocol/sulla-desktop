// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isContainerLifecycleLost } from '../languagemodels/cliFaultRecovery';

import type { AgentContainerLifecycle } from './AgentContainerLauncher';

export async function executeWithContainerLifecycleRecovery<T>(
  acquire: () => Promise<AgentContainerLifecycle>,
  recover: (lost: AgentContainerLifecycle) => Promise<AgentContainerLifecycle>,
  action: () => T,
): Promise<Awaited<T>> {
  let lifecycle = await acquire();
  try {
    return await lifecycle.execute(action);
  } catch (error) {
    if (!isContainerLifecycleLost(error)) throw error;
    lifecycle = await recover(lifecycle);
    return await lifecycle.execute(action);
  }
}
