// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentWaitRequest } from './AgentWaitRequest';
import type { AgentTaskParkingService } from './AgentTaskParkingService';

export interface DecisionQuestionAskerWaiter {
  park(jobId: string, taskIndex: number, decisionId: string): Promise<void>;
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
}
