// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { WorkerChartAgent } from './workerChartModel';

export class WorkerChartTimeFormatter {
  public elapsed(agent: WorkerChartAgent, now: number): string {
    if (agent.startedAt == null) return 'Not reported';
    const seconds = Math.max(0, Math.floor(((agent.finishedAt ?? now) - agent.startedAt) / 1_000));
    return this.span(seconds);
  }

  public lastCheckIn(agent: WorkerChartAgent, now: number): string {
    if (!agent.lastCheckIn) return 'none yet';
    const seconds = Math.max(0, Math.floor((now - agent.lastCheckIn.timestamp) / 1_000));
    return `${this.span(seconds)} ago`;
  }

  private span(seconds: number): string {
    const duration = Math.max(0, Math.floor(seconds));
    if (duration < 60) return `${duration}s`;
    return `${Math.floor(duration / 60)}m ${String(duration % 60).padStart(2, '0')}s`;
  }
}
