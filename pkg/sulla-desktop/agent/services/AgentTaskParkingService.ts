// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentTaskWaitRepository } from '../app/Repositories/AgentTaskWaitRepository';
import type { AgentWaitRequest } from './AgentWaitRequest';
import type { AgentWakeScheduler } from './AgentWakeScheduler';

export class AgentTaskParkingService {
  constructor(private readonly waits: AgentTaskWaitRepository, private readonly parkTask: (wait: AgentTaskWaitRepository extends never ? never : { jobId: string; taskIndex: number; reason: string; wakeAt: Date }) => Promise<boolean>, private readonly scheduler: AgentWakeScheduler) {}

  async park(jobId: string, taskIndex: number, request: AgentWaitRequest): Promise<void> {
    const wait = { jobId, taskIndex, wakeAt: request.wakeAt, reason: request.reason, state: 'scheduled' as const };
    await this.waits.schedule(wait);
    if (!await this.parkTask(wait)) {
      await this.waits.cancel(jobId, taskIndex);
      throw new Error('The delegated task is no longer running and cannot be parked.');
    }
    this.scheduler.schedule(wait);
  }
}
