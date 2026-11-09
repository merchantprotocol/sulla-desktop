// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';
import { BaseNode } from '../../nodes/BaseNode';
import type { BaseThreadState, NodeResult } from '../../nodes/Graph';

class ContextInjectionNode extends BaseNode {
  constructor() { super('test-context', 'test-context'); }
  async execute(state: BaseThreadState): Promise<NodeResult<BaseThreadState>> { return { state, decision: { type: 'next' } }; }
  inject(state: BaseThreadState): void { this.injectSubconsciousAssistantContext(state); }
}

describe('subconscious context injection', () => {
  it('keeps brain memory and support controls, but never injects prior-conversation recall', () => {
    // risk: memory/control context — removing historical recall must not remove brain recall or support-session restrictions.
    const state = {
      metadata: {
        brainMemoryContext: '[memory:42] durable fact',
        supportContext: 'Only use support tools.',
        conversationContext: 'historical content must not be injected',
      },
      messages: [{ role: 'user', content: 'Help' }],
    } as unknown as BaseThreadState;

    new ContextInjectionNode().inject(state);

    const injected = state.messages.filter((message: any) => message.metadata?.source === 'subconscious_context') as any[];
    expect(injected).toHaveLength(1);
    expect(injected[0].content).toContain('<brain_memory>\n[memory:42] durable fact\n</brain_memory>');
    expect(injected[0].content).toContain('<support_context>\nOnly use support tools.\n</support_context>');
    expect(injected[0].content).not.toContain('historical content');
    expect(injected[0].content).not.toContain('<conversation_context>');
  });
});
