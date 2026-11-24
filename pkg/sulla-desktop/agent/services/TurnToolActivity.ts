// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { RunActivity } from './RunActivity';
import { runTools, type RunToolTracker } from './RunToolTracker';

type ActivityToucher = Pick<typeof RunActivity, 'touch'>;

/**
 * Feeds one turn's tool calls into the job-level liveness clock. A tool call
 * starting, a tool result arriving and a tool still running are all agent
 * activity (Jonathon, 2026-11-24), so the dead-run reaper, the No-progress
 * alerts and the subagent directory see a busy agent as alive even when it
 * sends no chat message. `close()` releases anything the turn left open.
 */
export class TurnToolActivity {
  private readonly open = new Set<string>();

  constructor(
    private readonly metadata: any,
    private readonly tools: Pick<RunToolTracker, 'started' | 'finished'> = runTools,
    private readonly activity: ActivityToucher = RunActivity,
  ) {}

  started(callId: string | undefined, name: string | undefined): void {
    this.activity.touch(this.metadata);
    if (!callId || this.open.has(callId)) return;
    this.open.add(callId);
    this.tools.started(this.metadata, callId, name || 'a tool');
  }

  finished(callId: string | undefined): void {
    this.activity.touch(this.metadata);
    if (!callId || !this.open.delete(callId)) return;
    this.tools.finished(this.metadata, callId);
  }

  /** The turn ended: nothing it started is still running. */
  close(): void {
    for (const callId of this.open) this.tools.finished(this.metadata, callId);
    this.open.clear();
  }
}
