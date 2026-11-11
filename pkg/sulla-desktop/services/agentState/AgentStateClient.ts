// SPDX-License-Identifier: GPL-2.0-or-later
import { readonly, shallowRef, type ShallowRef } from 'vue';

import { AGENT_STATE_CHANGED_EVENT, AGENT_STATE_SNAPSHOT_CHANNEL, type AgentStateSnapshot } from '@pkg/shared/agentState/AgentStateSnapshot';

export interface AgentStateTransport {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, snapshot: AgentStateSnapshot) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, snapshot: AgentStateSnapshot) => void): unknown;
  send?(channel: string, ...args: unknown[]): void;
}
export interface AgentStateWindow {
  document: { visibilityState: string; addEventListener(type: string, listener: () => void): void; removeEventListener(type: string, listener: () => void): void };
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
  setInterval(handler: () => void, ms: number): ReturnType<typeof setInterval>;
  clearInterval(handle: ReturnType<typeof setInterval>): void;
}

const EMPTY: AgentStateSnapshot = { version: -1, generatedAt: new Date(0).toISOString(), rows: [] };

export class AgentStateClient {
  private readonly state = shallowRef<AgentStateSnapshot>(EMPTY);
  private readonly loadError = shallowRef('');
  private timer:     ReturnType<typeof setInterval> | null = null;
  private started = false;
  readonly snapshot: Readonly<ShallowRef<AgentStateSnapshot>> = readonly(this.state) as Readonly<ShallowRef<AgentStateSnapshot>>;
  readonly error: Readonly<ShallowRef<string>> = readonly(this.loadError) as Readonly<ShallowRef<string>>;

  constructor(private readonly transport: AgentStateTransport, private readonly host: AgentStateWindow, private readonly intervalMs = 15_000) {}

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.transport.on(AGENT_STATE_CHANGED_EVENT, this.onSnapshot);
    this.host.addEventListener('focus', this.onReconnect);
    this.host.addEventListener('online', this.onReconnect);
    this.host.document.addEventListener('visibilitychange', this.onVisibility);
    this.timer = this.host.setInterval(this.onReconnect, this.intervalMs);
    await this.resync();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.transport.removeListener(AGENT_STATE_CHANGED_EVENT, this.onSnapshot);
    this.host.removeEventListener('focus', this.onReconnect);
    this.host.removeEventListener('online', this.onReconnect);
    this.host.document.removeEventListener('visibilitychange', this.onVisibility);
    if (this.timer) this.host.clearInterval(this.timer);
    this.timer = null;
  }

  apply(snapshot: AgentStateSnapshot): boolean {
    if (!snapshot || snapshot.version <= this.state.value.version) return false;
    this.state.value = snapshot;
    return true;
  }

  async resync(): Promise<void> {
    try {
      const snapshot = await this.transport.invoke(AGENT_STATE_SNAPSHOT_CHANNEL) as AgentStateSnapshot;
      this.apply(snapshot);
      this.loadError.value = '';
    } catch (error) {
      this.loadError.value = error instanceof Error ? error.message : String(error);
      this.transport.send?.('debug:report', 'live-agents:snapshot', { message: this.loadError.value, stack: error instanceof Error ? error.stack : '' });
    }
  }

  private readonly onSnapshot = (_event: unknown, snapshot: AgentStateSnapshot): void => { this.apply(snapshot) };
  private readonly onReconnect = (): void => { void this.resync() };
  private readonly onVisibility = (): void => { if (this.host.document.visibilityState === 'visible') void this.resync(); };
}
