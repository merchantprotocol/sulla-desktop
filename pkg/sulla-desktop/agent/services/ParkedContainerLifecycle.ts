// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentContainerCleanupReceipt, AgentContainerLifecycle } from './AgentContainerLauncher';

/** Releases an idle-prone container while a task is durably parked and recreates it on wake. */
export class ParkedContainerLifecycle {
  private current?: AgentContainerLifecycle;
  constructor(initial: AgentContainerLifecycle, private readonly factory: () => Promise<AgentContainerLifecycle>) {
    this.current = initial;
  }

  execute<T>(action: () => T): T {
    if (!this.current) throw new Error('Cannot execute a parked container lifecycle before resume.');
    return this.current.execute(action);
  }

  async park(): Promise<void> {
    if (!this.current) return;
    await this.current.close('delegated-task-parked', 'ParkedContainerLifecycle.park');
    this.current = undefined;
  }

  async resume(): Promise<void> {
    if (!this.current) this.current = await this.factory();
  }

  async close(reason: string): Promise<AgentContainerCleanupReceipt | undefined> {
    return this.current?.close(reason, 'ParkedContainerLifecycle.close');
  }
}
