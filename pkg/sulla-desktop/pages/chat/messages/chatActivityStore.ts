// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive } from 'vue';

import { isChatTabActivitySnapshot, type ChatTabActivitySnapshot } from '@pkg/shared/ChatTabActivity';
import type { ipcRenderer } from '@pkg/utils/ipcRenderer';

export class ChatActivityStore {
  readonly snapshots = reactive(new Map<string, ChatTabActivitySnapshot>());
  private readonly running = reactive(new Set<string>());

  /** The shell owns the listeners; replacing a header doesn't reset either signal. */
  connect(events: EventTarget, ipc: Pick<typeof ipcRenderer, 'on' | 'removeListener'>): () => void {
    const onLocal = (event: Event) => {
      const { tabId, running, activity } = (event as CustomEvent<{ tabId?: string; running?: boolean; activity?: ChatTabActivitySnapshot }>).detail ?? {};

      if (tabId && typeof running === 'boolean') this.update(tabId, running, activity);
    };
    const onHosted = (_event: unknown, tabId: string, running: boolean, activity?: ChatTabActivitySnapshot) => {
      this.update(tabId, running, activity);
    };

    events.addEventListener('sulla:chat-running', onLocal);
    ipc.on('internal-tab-view:chat-running', onHosted);
    return () => {
      events.removeEventListener('sulla:chat-running', onLocal);
      ipc.removeListener('internal-tab-view:chat-running', onHosted);
    };
  }

  read(tabId: string) {
    const snapshot = this.snapshots.get(tabId);

    return { snapshot, working: this.running.has(tabId) || snapshot?.state === 'working' };
  }

  private update(tabId: string, running: boolean, activity?: ChatTabActivitySnapshot): void {
    if (running) this.running.add(tabId);
    else this.running.delete(tabId);
    if (isChatTabActivitySnapshot(activity)) {
      const previous = this.snapshots.get(tabId);

      if (previous?.state !== activity.state || previous?.detail !== activity.detail) this.snapshots.set(tabId, activity);
    }
  }
}

export const chatActivityStore = new ChatActivityStore();
/** Used by the local thread status line; hosted tabs deliver through the IPC bridge. */
export const chatActivityByTab = chatActivityStore.snapshots;
