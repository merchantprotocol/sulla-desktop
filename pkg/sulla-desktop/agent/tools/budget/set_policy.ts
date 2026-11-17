// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { budgetPolicyService } from '../../services/BudgetPolicyService';
import { BaseTool, type ToolResponse } from '../base';

export class BudgetSetPolicyWorker extends BaseTool {
  name = ''; description = '';
  protected async _validatedCall(input: any): Promise<ToolResponse> {
    try {
      const policy = await budgetPolicyService.setPolicy(input.policy);
      return { successBoolean: true, responseString: JSON.stringify(policy, null, 2), result: policy };
    } catch (error) { return { successBoolean: false, responseString: `Invalid budget policy: ${(error as Error).message}` }; }
  }
}
