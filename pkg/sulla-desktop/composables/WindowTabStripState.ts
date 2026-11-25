// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { reactive, ref, type InjectionKey } from 'vue';

import { isChatTabActivitySnapshot, type ChatTabActivitySnapshot } from '@pkg/shared/ChatTabActivity';
import type { ipcRenderer } from '@pkg/utils/ipcRenderer';
import type { TabGroupId } from './TabGroupModel';

interface Request {
  id:       string;
  select:   (action: string) => void;
  onClosed: () => void;
}

/** Owns tab activity and menu reply routing for the life of one window shell. */
export class WindowTabStripState {
  private readonly snapshots = reactive(new Map<string, ChatTabActivitySnapshot>());
  private readonly running = reactive(new Set<string>());
  readonly activeGroup = ref<TabGroupId>('chats');
  private current?: Request;
  private connected = false;

  constructor(
    private readonly events: EventTarget,
    private readonly ipc: Pick<typeof ipcRenderer, 'on' | 'removeListener'>,
  ) {}

  connect(): void {
    if (this.connected) return;
    this.connected = true;
    this.events.addEventListener('sulla:chat-running', this.onLocalRunning);
    this.ipc.on('internal-tab-view:chat-running', this.onHostedActivity);
    this.ipc.on('tab-context-menu:selected', this.onSelected);
    this.ipc.on('tab-context-menu:closed', this.onClosed);
  }

  dispose(): void {
    if (!this.connected) return;
    this.connected = false;
    this.events.removeEventListener('sulla:chat-running', this.onLocalRunning);
    this.ipc.removeListener('internal-tab-view:chat-running', this.onHostedActivity);
    this.ipc.removeListener('tab-context-menu:selected', this.onSelected);
    this.ipc.removeListener('tab-context-menu:closed', this.onClosed);
    if (this.current) this.close(this.current.id);
    this.snapshots.clear();
    this.running.clear();
  }

  readActivity(tabId: string) {
    const snapshot = this.snapshots.get(tabId);

    return { snapshot, working: this.running.has(tabId) || snapshot?.state === 'working' };
  }

  setSnapshot(tabId: string, activity: ChatTabActivitySnapshot): void {
    const previous = this.snapshots.get(tabId);

    if (previous?.state !== activity.state || previous?.detail !== activity.detail) this.snapshots.set(tabId, activity);
  }

  clearSnapshot(tabId: string): void {
    this.snapshots.delete(tabId);
  }

  setActiveGroup(group: TabGroupId): void {
    this.activeGroup.value = group;
  }

  open(request: Request): void {
    if (this.current) this.close(this.current.id);
    this.current = request;
  }

  openForTab<T>(id: string, getTab: () => T | undefined, select: (action: string, tab: T) => void, onClosed: () => void): void {
    this.open({
      id,
      select: action => {
        const tab = getTab();

        if (tab !== undefined) select(action, tab);
      },
      onClosed,
    });
  }

  close(id: string): void {
    this.take(id);
  }

  private readonly onLocalRunning = (event: Event): void => {
    const { tabId, running, activity } = (event as CustomEvent<{ tabId?: string; running?: boolean; activity?: ChatTabActivitySnapshot }>).detail ?? {};

    if (tabId && typeof running === 'boolean') this.onHostedActivity(undefined, tabId, running, activity);
  };

  private readonly onHostedActivity = (_event: unknown, tabId: string, running: boolean, activity?: ChatTabActivitySnapshot): void => {
    if (running) this.running.add(tabId);
    else this.running.delete(tabId);
    if (isChatTabActivitySnapshot(activity)) this.setSnapshot(tabId, activity);
  };

  private readonly onSelected = (_event: unknown, id: string, action: string): void => {
    this.take(id)?.select(action);
  };

  private readonly onClosed = (_event: unknown, id: string): void => {
    this.close(id);
  };

  private take(id: string): Request | undefined {
    const request = this.current;

    if (request?.id !== id) return undefined;
    this.current = undefined;
    request.onClosed();
    return request;
  }
}

export const windowTabStripKey: InjectionKey<WindowTabStripState> = Symbol('window-tab-strip');
