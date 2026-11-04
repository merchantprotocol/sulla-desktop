// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { getChatHeartbeatService } from './ChatHeartbeatService';

import type { AgentJobTask } from '../tools/agents/jobRegistry';

export interface HeartbeatUnregistry { unregister(threadId: string): void; }

/**
 * A job ending (returned, stopped, or failed) is the one truthful signal a
 * heartbeat should stop firing on its thread — re-validating policy on each
 * beat (JobHeartbeatDelivery) still catches the case between a job ending and
 * its next scheduled beat, but ending it here means it never fires even once
 * more after that.
 */
export class JobHeartbeatCleanup {
  constructor(private readonly scheduler: HeartbeatUnregistry) {}

  disableForTasks(tasks: Pick<AgentJobTask, 'threadId'>[]): void {
    for (const task of tasks) if (task.threadId) this.scheduler.unregister(task.threadId);
  }
}

export const jobHeartbeatCleanup = new JobHeartbeatCleanup({
  unregister: (threadId) => getChatHeartbeatService().unregister(threadId),
});
