// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';
import type { AgentWaitRequest } from './AgentWaitRequest';
import type { AgentWakeScheduler } from './AgentWakeScheduler';

export class AgentTaskParkingService {
  constructor(private readonly waits: AgentTaskWaitRepository, private readonly parkTask: (jobId: string, taskIndex: number, waitingOnChildren: number) => Promise<void>, private readonly scheduler: AgentWakeScheduler) {}

  async park(jobId: string, taskIndex: number, request: AgentWaitRequest): Promise<void> {
    const wait = { jobId, taskIndex, wakeAt: request.wakeAt, reason: request.reason, state: 'scheduled' as const };
    await this.waits.schedule(wait);
    await this.parkTask(jobId, taskIndex, 0);
    this.scheduler.schedule(wait);
  }
}
