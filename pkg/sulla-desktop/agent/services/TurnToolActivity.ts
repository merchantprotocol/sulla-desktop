// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';

import { RunActivity } from './RunActivity';
import { runTools, type RunToolTracker } from './RunToolTracker';

type ActivityToucher = Pick<typeof RunActivity, 'touch'>;

/**
 * Feeds one turn's tool calls into the job-level liveness clock. A tool call
 * starting, a tool result arriving and a tool still running are all agent
 * activity (Jonathon, 2026-11-24), so the dead-run reaper, the No-progress
 * alerts and the subagent directory see a busy agent as alive even when it
 * sends no chat message. `close()` releases anything the turn left open.
 *
 * Provider call ids are not unique across a job: Codex numbers items per
 * process (item_0, item_1, …), and parallel tasks and child agents share the
 * job's activity keys. Each turn therefore registers its calls under its own
 * scope, so one task finishing item_3 never clears another task's item_3.
 */
export class TurnToolActivity {
  private readonly open = new Set<string>();
  private readonly scope = crypto.randomUUID();

  constructor(
    private readonly metadata: any,
    private readonly tools: Pick<RunToolTracker, 'started' | 'finished'> = runTools,
    private readonly activity: ActivityToucher = RunActivity,
  ) {}

  started(callId: string | undefined, name: string | undefined): void {
    this.activity.touch(this.metadata);
    if (!callId || this.open.has(callId)) return;
    this.open.add(callId);
    this.tools.started(this.metadata, this.scoped(callId), name || 'a tool');
  }

  finished(callId: string | undefined): void {
    this.activity.touch(this.metadata);
    if (!callId || !this.open.delete(callId)) return;
    this.tools.finished(this.metadata, this.scoped(callId));
  }

  /** The turn ended: nothing it started is still running. */
  close(): void {
    for (const callId of this.open) this.tools.finished(this.metadata, this.scoped(callId));
    this.open.clear();
  }

  private scoped(callId: string): string {
    return `${ this.scope }:${ callId }`;
  }
}
