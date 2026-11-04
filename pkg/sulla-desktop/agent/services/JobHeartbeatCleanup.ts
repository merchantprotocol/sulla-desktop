// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { JobTerminalListener } from '../app/Services/JobTerminalObserver';
import type { AgentJob, AgentJobTask } from '../tools/agents/jobRegistry';

export interface HeartbeatUnregistry { unregister(threadId: string): void; }

/**
 * A job ending (returned, stopped, or failed) is the one truthful signal a
 * heartbeat should stop firing on its thread — re-validating policy on each
 * beat (JobHeartbeatDelivery) still catches the case between a job ending and
 * its next scheduled beat, but ending it here means it never fires even once
 * more after that.
 *
 * Deliberately has no module-level singleton or subscription: its only real
 * production trigger is AgentJobService's JobTerminalObserver, and wiring
 * that up here at import time created a module nothing production actually
 * imported, so cleanup silently never ran. The real composition root
 * (getChatHeartbeatService in ChatHeartbeatService.ts, which constructs the
 * scheduler this class unregisters from) subscribes an instance of this
 * class to agentJobProvider.terminalTransitions instead — see there for why,
 * and for the import-cycle this split avoids.
 */
export class JobHeartbeatCleanup implements JobTerminalListener {
  constructor(private readonly scheduler: HeartbeatUnregistry) {}

  disableForTasks(tasks: Pick<AgentJobTask, 'threadId'>[]): void {
    for (const task of tasks) if (task.threadId) this.scheduler.unregister(task.threadId);
  }

  onJobTerminal(job: AgentJob): void {
    this.disableForTasks(job.tasks);
  }
}
