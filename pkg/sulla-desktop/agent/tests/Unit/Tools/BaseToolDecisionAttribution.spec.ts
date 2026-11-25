// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { BaseTool, type ToolResponse } from '../../../tools/base';
import { toolDecisionPort, UnavailableToolDecisionPort } from '../../../tools/toolDecisionPort';

class DecisionAttributionTool extends BaseTool {
  name = 'test_write';
  description = 'Test decision attribution.';
  metadata = { category: 'test', operationTypes: ['execute'] as const };
  protected async _validatedCall(): Promise<ToolResponse> { return { successBoolean: true, responseString: 'Write completed.' } }
}

afterEach(() => toolDecisionPort.register(new UnavailableToolDecisionPort()));

describe('decision attribution in tool results', () => {
  it('names the actor who approved a gated action in its result text', async() => {
    toolDecisionPort.register({
      requiresApproval: vi.fn(async() => true),
      request: vi.fn(async() => ({
        record: { id: 'decision-1', title: 'Approve?', kind: 'approval' } as any,
        result: Promise.resolve({ status: 'approved', answers: [], answeredBy: { kind: 'agent', agentId: 'coding-manager', label: 'Jonathon' } }),
      })),
    });
    const result = await new DecisionAttributionTool().call({});
    expect(result).toMatchObject({ success: true, result: 'Write completed.\nApproved by agent Jonathon.' });
  });

  it('names who denied a gated action without running it', async() => {
    const execute = vi.fn(async() => ({ successBoolean: true, responseString: 'should not run' }));
    class DeniedTool extends DecisionAttributionTool { protected async _validatedCall(): Promise<ToolResponse> { return execute() } }
    toolDecisionPort.register({
      requiresApproval: vi.fn(async() => true),
      request: vi.fn(async() => ({
        record: { id: 'decision-2', title: 'Approve?', kind: 'approval' } as any,
        result: Promise.resolve({ status: 'denied', answers: [], answeredBy: { kind: 'agent', agentId: 'coding-manager', label: 'Coding Manager' } }),
      })),
    });
    const result = await new DeniedTool().call({});
    expect(result).toMatchObject({ success: false, error: 'Action denied by agent Coding Manager; nothing was executed.' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('attributes human approval without embedding a personal name in product text', async() => {
    toolDecisionPort.register({
      requiresApproval: vi.fn(async() => true),
      request: vi.fn(async() => ({
        record: { id: 'decision-3', title: 'Approve?', kind: 'approval' } as any,
        result: Promise.resolve({ status: 'approved', answers: [], answeredBy: { kind: 'human' as const } }),
      })),
    });
    await expect(new DecisionAttributionTool().call({})).resolves.toMatchObject({
      success: true, result: 'Write completed.\nApproved by your human.',
    });
  });
});
