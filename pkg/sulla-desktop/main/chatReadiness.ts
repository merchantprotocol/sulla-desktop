// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Whether the first chat can start right away: every chat runs in an agent
 * container, which needs the tools service, an unlocked vault, the agent
 * image and (with scanning on) the threat proxy's CA. The first-run
 * Finishing screen shows this as its last line ('first-run:chat-ready-status').
 * Once chat is ready the setup window closes and the chat opens
 * ('first-run-chat-ready'); it never waits on the remaining background services. Once the vault unlocks, the slow parts
 * (image load, threat proxy) are warmed up in the background.
 */

import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { isSullaRuntimeActive } from '@pkg/backend/sullaRuntime/state';
import { firstRunTrace } from '@pkg/main/firstRun/firstRunTrace';
import mainEvents from '@pkg/main/mainEvents';
import Logging from '@pkg/utils/logging';
import * as window from '@pkg/window';

const console = Logging.sulla;

export interface ChatReadyStatus {
  ready:     boolean;
  /** Plain words for what is not ready yet, e.g. 'tools', 'vault', 'agent image'. */
  waitingOn: string[];
}

const POLL_MS = 5_000;
/** Let the services that just unlocked start before the warm-up competes with them. */
const WARM_UP_DELAY_MS = 10_000;

let last: ChatReadyStatus | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let started = false;

export async function chatReadyStatus(): Promise<ChatReadyStatus> {
  if (!isSullaRuntimeActive()) return { ready: false, waitingOn: ['engine'] };
  const launcher = await import('@pkg/agent/services/AgentContainerLauncher');
  const [tools, image, proxy] = await Promise.all([
    launcher.toolsServiceHealthy(),
    launcher.agentImagePresent(),
    launcher.threatProxyWarm().catch(() => false),
  ]);
  const waitingOn = [
    ...(tools ? [] : ['tools']),
    ...(getServiceLifecycleManager().isVaultUnlocked() ? [] : ['vault']),
    ...(image ? [] : ['agent image']),
    ...(proxy ? [] : ['web safety check']),
  ];

  return { ready: waitingOn.length === 0, waitingOn };
}

/** Recheck now; push the status when it changed, and keep polling until ready. */
async function refresh(): Promise<ChatReadyStatus> {
  clearTimeout(pollTimer);
  pollTimer = undefined;
  const status = await chatReadyStatus().catch((error) => {
    console.warn('[ChatReady] status check failed:', error);

    return { ready: false, waitingOn: ['engine'] };
  });

  if (!last || last.ready !== status.ready || last.waitingOn.join() !== status.waitingOn.join()) {
    last = status;
    firstRunTrace('chat', status.ready ? 'chat ready' : 'chat not ready yet', { waitingOn: status.waitingOn });
    window.send('first-run:chat-ready-status', status);
    if (status.ready) mainEvents.emit('first-run-chat-ready');
  }
  if (!status.ready) {
    pollTimer = setTimeout(() => void refresh(), POLL_MS);
    pollTimer.unref?.();
  }

  return status;
}

/** Register the IPC handler and the vault-unlock warm-up. Call once at startup. */
export function startChatReadiness(ipcMainProxy: { handle: (channel: any, listener: (...args: any[]) => any) => void }): void {
  if (started) return;
  started = true;
  ipcMainProxy.handle('first-run:chat-ready-status', () => refresh());
  getServiceLifecycleManager().on('vault:state', (unlocked: boolean) => {
    if (last) void refresh();
    if (!unlocked || !isSullaRuntimeActive()) return;
    setTimeout(() => {
      void import('@pkg/agent/services/AgentContainerLauncher')
        .then(({ warmAgentLaunch }) => warmAgentLaunch())
        .then(() => { if (last) void refresh() });
    }, WARM_UP_DELAY_MS).unref?.();
  });
}
