// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { FleetTaskView } from './AgentFleetTypes';
import type { ManagerActivitySource } from './StrandedManagerDetector';

export interface RunActivityReader { lastActivityAt(key: string): number | undefined }

/** Reads live model/tool activity for one delegated task, independently of its durable timestamps. */
export class RunActivityManagerActivitySource implements ManagerActivitySource {
  constructor(private readonly activity: RunActivityReader, private readonly activeWindowMs = 10 * 60_000) {}

  isActive(jobId: string, taskIndex: number, _task: FleetTaskView, now: number): boolean {
    const lastActivityAt = this.activity.lastActivityAt(`${ jobId }#${ taskIndex }`);
    return lastActivityAt !== undefined && now - lastActivityAt < this.activeWindowMs;
  }
}
