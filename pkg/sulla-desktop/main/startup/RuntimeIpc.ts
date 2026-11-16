// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { MainProcessIpcContext, MainProcessIpcStep } from './MainProcessIpcContext';

/** First-chat readiness, managed-service repair, container intents and the last runtime start failure. */
export class RuntimeIpc implements MainProcessIpcStep {
  readonly name = 'runtime';

  async register(ctx: MainProcessIpcContext): Promise<void> {
    const { ipc } = ctx;

    // ── Runtime: first-chat readiness, Repair, and the last start failure ──
    const { startChatReadiness } = await import('@pkg/main/chatReadiness');
    startChatReadiness(ipc);
    ipc.handle('sulla-runtime:repair-services', async() => {
      const { default: mainEvents } = await import('@pkg/main/mainEvents');

      mainEvents.emit('sulla-managed-services-repair');
    });
    ipc.handle('docker/container-intent', async(_event: unknown, intent: unknown, names: unknown) => {
      if (typeof intent !== 'string' || !['stop', 'start', 'restart', 'remove'].includes(intent) || !Array.isArray(names)) {
        throw new Error('Unknown container action');
      }
      const { default: mainEvents } = await import('@pkg/main/mainEvents');

      mainEvents.emit(
        'sulla-container-intent',
        intent as import('@pkg/backend/sullaContainerHealth').ContainerIntent,
        names.filter((name): name is string => typeof name === 'string'),
      );
    });
    ipc.handle('sulla-runtime:start-failure', async() => {
      const { sullaRuntimeStartFailure } = await import('@pkg/backend/sullaRuntime/state');

      return sullaRuntimeStartFailure();
    });
  }
}
