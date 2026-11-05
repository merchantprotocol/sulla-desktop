// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ref, type Ref } from 'vue';

interface KillResult { ok: boolean; killedJobs: number; error?: string }
interface KillSwitchState { on: boolean; since?: number }
interface LiveAgentsKillIpc {
  invoke(channel: 'agents:kill-tree', threadId: string): Promise<KillResult>;
  invoke(channel: 'agents:kill-all-switch:get'): Promise<KillSwitchState>;
  invoke(channel: 'agents:kill-all-switch:set', on: boolean): Promise<KillResult>;
}

/** Coordinates destructive Live Agents actions and owns their UI state. */
export class LiveAgentsKillController {
  readonly switchOn: Ref<boolean> = ref(false);
  readonly switchSince: Ref<number | undefined> = ref(undefined);
  readonly busy: Ref<boolean> = ref(false);
  readonly error: Ref<string> = ref('');
  readonly notice: Ref<string> = ref('');

  constructor(private readonly ipc: LiveAgentsKillIpc) {}

  async loadSwitch(): Promise<void> {
    try {
      const state = await this.ipc.invoke('agents:kill-all-switch:get');
      this.switchOn.value = state.on;
      this.switchSince.value = state.since;
    } catch (error) {
      this.error.value = this.message(error);
    }
  }

  async killTree(threadId: string): Promise<boolean> {
    return this.run(async () => {
      const result = await this.ipc.invoke('agents:kill-tree', threadId);
      if (!result.ok) throw new Error(result.error || 'The agent tree could not be killed.');
      this.notice.value = `${result.killedJobs} agent${result.killedJobs === 1 ? '' : 's'} killed by human.`;
    });
  }

  async setSwitch(on: boolean): Promise<boolean> {
    return this.run(async () => {
      const result = await this.ipc.invoke('agents:kill-all-switch:set', on);
      if (!result.ok) throw new Error(result.error || 'The Kill All switch could not be changed.');
      this.switchOn.value = on;
      this.switchSince.value = on ? Date.now() : undefined;
      this.notice.value = on
        ? `All agent launches paused. ${result.killedJobs} agent${result.killedJobs === 1 ? '' : 's'} killed.`
        : 'Agent launches re-enabled.';
    });
  }

  clearFeedback(): void {
    this.error.value = '';
    this.notice.value = '';
  }

  private async run(action: () => Promise<void>): Promise<boolean> {
    this.busy.value = true;
    this.clearFeedback();
    try {
      await action();
      return true;
    } catch (error) {
      this.error.value = this.message(error);
      return false;
    } finally {
      this.busy.value = false;
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
