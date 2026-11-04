// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AgentJob } from '../../tools/agents/jobRegistry';

export interface JobTerminalListener { onJobTerminal(job: AgentJob): void; }

/**
 * AgentJobService's one hook for "this job just turned terminal" — every
 * subscriber runs synchronously from every entry point that can end a job
 * (abortJob, completeJob, failJob, stopJobCascade), so cleanup such as
 * heartbeat unregistration can never be skipped by a caller that reaches the
 * service directly instead of through the jobRegistry wrappers.
 */
export class JobTerminalObserver {
  private readonly listeners: JobTerminalListener[] = [];

  subscribe(listener: JobTerminalListener): void {
    this.listeners.push(listener);
  }

  notify(job: AgentJob): void {
    for (const listener of this.listeners) listener.onJobTerminal(job);
  }
}
