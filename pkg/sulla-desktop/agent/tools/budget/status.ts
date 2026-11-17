// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { getUsageSummary } from '../../usage/providerUsage';
import { getAllJobs } from '../agents/jobRegistry';
import { budgetPolicyService } from '../../services/BudgetPolicyService';
import { BaseTool, type ToolResponse } from '../base';

export class BudgetStatusWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(): Promise<ToolResponse> {
    const [policy, jobs, usage] = await Promise.all([budgetPolicyService.read(), getAllJobs(), getUsageSummary(168)]);
    const running = jobs.filter(job => job.visibility !== 'tab').reduce((count, job) => count + job.tasks.filter(task => task.status === 'running').length, 0);
    const payload = { policy, running, providerLimits: usage.limits };
    return { successBoolean: true, responseString: JSON.stringify(payload, null, 2), result: payload };
  }
}
