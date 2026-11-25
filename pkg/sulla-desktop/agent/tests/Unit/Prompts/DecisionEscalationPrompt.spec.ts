// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';
import { SystemPromptBuilder, type PromptBuildContext } from '../../../prompts/SystemPromptBuilder';
import { buildDecisionEscalationSection, DECISION_ESCALATION_GUIDANCE } from '../../../prompts/sections/decisionEscalation';
import '../../../prompts/sections';

function context(agentAwareness: boolean, tools: string[]): PromptBuildContext {
  return {
    mode: 'full', agentId: 'coding-manager', agentConfig: { tools }, provider: 'openai', chatMode: 'text', trustLevel: 'trusted',
    isSubAgent: true, isHeartbeat: false, wsChannel: 'sulla-desktop', agentAwareness, toolMode: 'full',
    templateVars: {}, agentSectionOverrides: new Map(),
    excludeSections: new Set(SystemPromptBuilder.getRegisteredSectionIds().filter(id => id !== 'decision_escalation')),
    basePrompt: 'base prompt',
  };
}

describe('decision escalation prompt section', () => {
  it('keeps an unaware worker built prompt byte-identical when the section is registered', async() => {
    // risk: privacy and prompt size — an agent with Sees other agents OFF must receive zero new bytes.
    const current = await SystemPromptBuilder.build(context(false, ['agents/spawn_agent']));
    expect(buildDecisionEscalationSection(context(false, ['agents/spawn_agent']))).toBeNull();

    SystemPromptBuilder.unregister('decision_escalation');
    let withoutSection: Awaited<ReturnType<typeof SystemPromptBuilder.build>>;
    try {
      withoutSection = await SystemPromptBuilder.build(context(false, ['agents/spawn_agent']));
    } finally {
      SystemPromptBuilder.register('decision_escalation', buildDecisionEscalationSection, ['full', 'minimal', 'local']);
    }
    const withSection = await SystemPromptBuilder.build(context(false, ['agents/spawn_agent']));
    expect(withSection.text).toBe(withoutSection.text);
    expect(current.text).toBe(withSection.text);
  });

  it('adds guidance exactly once to an aware manager and omits it from a non-manager allowlist', async() => {
    // risk: decision correctness — a parent needs holder instructions while unrelated workers stay lean.
    const manager = await SystemPromptBuilder.build(context(true, ['agents/spawn_agent']));
    expect(manager.text.split(DECISION_ESCALATION_GUIDANCE).length - 1).toBe(1);

    const worker = await SystemPromptBuilder.build(context(true, ['exec']));
    expect(worker.text).not.toContain(DECISION_ESCALATION_GUIDANCE);
  });
});
