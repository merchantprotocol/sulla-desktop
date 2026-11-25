// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentWaitRequest } from './AgentWaitRequest';
import type { AgentTaskParkingService } from './AgentTaskParkingService';
import type { AgentJobTaskTarget } from '../database/models/AgentJobMessagingModel';

export interface DecisionQuestionAskerWaiter {
  park(jobId: string, taskIndex: number, decisionId: string): Promise<void>;
  parkQuestionAsker(asker: AgentJobTaskTarget | null | undefined, decisionId: string): Promise<boolean>;
}

/** Parks a delegated asker durably; the decision id survives beyond this tool call. */
export class DecisionAskerWaiter implements DecisionQuestionAskerWaiter {
  constructor(private readonly parking: Pick<AgentTaskParkingService, 'park'> | (() => Promise<Pick<AgentTaskParkingService, 'park'>>) =
    async() => (await import('./AgentWaitServices')).agentWaitProvider.parking) {}

  async park(jobId: string, taskIndex: number, decisionId: string): Promise<void> {
    const parking = typeof this.parking === 'function' ? await this.parking() : this.parking;
    const request = AgentWaitRequest.create(AgentWaitRequest.MAX_SECONDS, `Waiting for decision ${ decisionId }`);
    await parking.park(jobId, taskIndex, request);
  }

  async parkQuestionAsker(asker: AgentJobTaskTarget | null | undefined, decisionId: string): Promise<boolean> {
    if (!asker || !['running', 'parked'].includes(asker.jobStatus) || !['running', 'parked'].includes(asker.taskStatus)) return false;
    try { await this.park(asker.jobId, asker.taskIndex, decisionId); return true }
    catch (error) { console.warn('[DecisionAskerWaiter] Could not park asker for question:', error); return false }
  }
}
