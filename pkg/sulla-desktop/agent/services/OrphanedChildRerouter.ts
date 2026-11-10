// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentJobResult } from '../tools/agents/jobRegistry';
import type { OrphanedChildCapture } from './OrphanedChildResultService';

/** Builds a grandparent-facing result when a child outlives its manager. */
export class OrphanedChildRerouter {
  results(capture: OrphanedChildCapture, results: AgentJobResult[]): AgentJobResult[] {
    const managerTask = capture.manager.tasks[capture.managerTaskIndex];
    const reason = managerTask?.completion?.output ?? capture.manager.error ?? capture.manager.stopReason ?? capture.notice.managerStatus;
    const lastCheckIn = managerTask?.waitReason ? `; last check-in: ${ managerTask.waitReason }` : '';
    const header = `orphaned from failed manager ${ capture.manager.jobId }#${ capture.managerTaskIndex }: ${ reason }${ lastCheckIn}`;
    return results.map(result => ({ ...result, output: `[${ header }]\n\n${ result.output }` }));
  }
}
