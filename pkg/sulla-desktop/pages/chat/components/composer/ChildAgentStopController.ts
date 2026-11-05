// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ref, type Ref } from 'vue';

export interface AgentKillIpc {
  invoke(channel: 'agents:thread-live-children', threadId: string): Promise<{ count: number }>;
  invoke(channel: 'agents:kill-tree', threadId: string): Promise<{ ok: boolean; killedJobs: number; error?: string }>;
}

/** Owns the short-lived child-agent prompt shown after a parent-only stop. */
export class ChildAgentStopController {
  readonly childCount: Ref<number> = ref(0);
  readonly error: Ref<string> = ref('');

  private dismissTimer?: ReturnType<typeof setTimeout>;

  constructor(
    private readonly ipc: AgentKillIpc,
    private readonly dismissAfterMs = 10_000,
  ) {}

  async inspect(threadId: string): Promise<void> {
    this.dismiss();
    if (!threadId) return;
    try {
      const result = await this.ipc.invoke('agents:thread-live-children', threadId);
      if (result.count < 1) return;
      this.childCount.value = result.count;
      this.dismissTimer = setTimeout(() => this.dismiss(), this.dismissAfterMs);
    } catch (error) {
      this.error.value = this.message(error);
    }
  }

  async kill(threadId: string): Promise<number> {
    this.error.value = '';
    try {
      const result = await this.ipc.invoke('agents:kill-tree', threadId);
      if (!result.ok) throw new Error(result.error || 'The sub-agents could not be killed.');
      this.dismiss();
      return result.killedJobs;
    } catch (error) {
      this.error.value = this.message(error);
      return 0;
    }
  }

  dismiss(): void {
    if (this.dismissTimer) clearTimeout(this.dismissTimer);
    this.dismissTimer = undefined;
    this.childCount.value = 0;
    this.error.value = '';
  }

  dispose(): void {
    this.dismiss();
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
