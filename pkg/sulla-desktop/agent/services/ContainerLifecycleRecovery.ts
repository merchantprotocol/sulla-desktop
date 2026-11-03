// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isContainerLifecycleLost } from '../languagemodels/cliFaultRecovery';

import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';

import type { AgentContainerLifecycle } from './AgentContainerLauncher';

/** How long a chat keeps retrying a launch that failed because Sulla is still starting. */
const LAUNCH_RETRY_BUDGET_MS = 8 * 60_000;
const LAUNCH_RETRY_DELAY_MS = 10_000;

/**
 * Acquire the conversation's container, retrying while the launch fails only
 * because part of Sulla is still starting (an AgentLaunchError marked
 * retryable). The user's message stays queued in this turn; `onWaiting` tells
 * them why it is taking a while, once per reason.
 */
export async function acquireWhenReady<T>(
  acquire: () => Promise<T>,
  onWaiting: (message: string) => void,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + LAUNCH_RETRY_BUDGET_MS;
  let lastReason = '';

  for (;;) {
    try {
      return await acquire();
    } catch (error) {
      const launch = error as { name?: string; retryable?: boolean; message?: string; detail?: string };

      if (launch?.name !== 'AgentLaunchError' || !launch.retryable || signal?.aborted || Date.now() >= deadline) throw error;
      console.warn(`[AgentContainer] Launch not ready (${ launch.message }); retrying: ${ launch.detail ?? '' }`);
      firstRunTrace('chat', 'agent launch not ready; retrying', { shown: launch.message, detail: launch.detail });
      if (launch.message !== lastReason) {
        lastReason = launch.message ?? '';
        onWaiting(`${ lastReason } - retrying…`);
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, LAUNCH_RETRY_DELAY_MS);

        signal?.addEventListener('abort', done, { once: true });
      });
    }
  }
}

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
