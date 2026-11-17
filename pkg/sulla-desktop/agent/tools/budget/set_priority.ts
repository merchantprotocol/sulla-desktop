// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { budgetPolicyService } from '../../services/BudgetPolicyService';
import { BaseTool, type ToolResponse } from '../base';

export class BudgetSetPriorityWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    if (!['human-first', 'balanced', 'sulla-first'].includes(input.priority)) return { successBoolean: false, responseString: 'priority must be human-first, balanced, or sulla-first.' };
    if (input.until !== undefined && (typeof input.until !== 'string' || !Number.isFinite(Date.parse(input.until)))) return { successBoolean: false, responseString: 'until must be an ISO time.' };
    try {
      const policy = await budgetPolicyService.setPriority(input.priority, input.until);
      return { successBoolean: true, responseString: JSON.stringify({ machine: policy.machine }), result: { machine: policy.machine } };
    } catch (error) { return { successBoolean: false, responseString: `Could not write budget policy: ${(error as Error).message}` }; }
  }
}
