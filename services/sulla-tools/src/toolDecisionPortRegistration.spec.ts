// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import { BaseTool } from '../../../pkg/sulla-desktop/agent/tools/base';
import { DecisionService, decisionService } from '../../../pkg/sulla-desktop/agent/services/DecisionService';
import { toolDecisionPort, ToolDecisionPortRegistry, UnavailableToolDecisionPort } from '../../../pkg/sulla-desktop/agent/tools/toolDecisionPort';

import { registerContainerToolDecisionPort } from './toolDecisionPortRegistration';

class EchoProbeTool extends BaseTool {
  name = 'echo_probe';
  description = 'Container approval probe';

  protected async _validatedCall(): Promise<any> {
    return { successBoolean: true, responseString: 'ran' };
  }
}

describe('Tools container tool approval port', () => {
  it('registers the real DecisionService, never the fail-closed default', () => {
    // risk: if the container keeps UnavailableToolDecisionPort, every approval-gated tool call is refused.
    const registry = new ToolDecisionPortRegistry();
    expect(registry.resolve()).toBeInstanceOf(UnavailableToolDecisionPort);
    registerContainerToolDecisionPort(registry);
    expect(registry.resolve()).toBe(decisionService);
  });

  it('is the port tool calls resolve when the container entry imports the registration', () => {
    // risk: an unregistered singleton makes base.ts refuse every tool in the container.
    expect(toolDecisionPort.resolve()).toBe(decisionService);
    expect(toolDecisionPort.resolve()).toBeInstanceOf(DecisionService);
  });

  it('runs a tool with no approval policy through BaseTool.call without a refusal', async() => {
    // risk: a container port that requires approval for everything (or refuses requests) breaks every tool call.
    // Container-like setup: a real DecisionService with fake repositories, so no Postgres or WebSocket is touched.
    const approvalPolicies = { exists: vi.fn(async() => false) };
    const service = new DecisionService(
      {} as never,
      { decisions: {} as never, approvalPolicies: approvalPolicies as never },
    );
    toolDecisionPort.register(service);
    try {
      const result = await new EchoProbeTool().call({});
      expect(approvalPolicies.exists).toHaveBeenCalledWith('echo_probe');
      expect(result).toMatchObject({ toolName: 'echo_probe', success: true, result: 'ran' });
    } finally {
      toolDecisionPort.register(decisionService);
    }
  });
});
