// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isCliManagedLoop, type BaseLanguageModel, type ChatMessage } from '../../languagemodels/BaseLanguageModel';
import { InputHandlerNode } from '../InputHandlerNode';

const provider = (cliManaged: boolean) => ({ managesOwnLoop: () => cliManaged }) as BaseLanguageModel;

describe('CLI-managed loop context guard', () => {
  it('identifies CLI providers and leaves their transcript untrimmed and unsummarized', async() => {
    const cli = provider(true);
    const api = provider(false);
    expect(isCliManagedLoop(cli)).toBe(true);
    expect(isCliManagedLoop(api)).toBe(false);

    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'stale Sulla summary', metadata: { _conversationSummary: true } },
      ...Array.from({ length: 41 }, (_, index): ChatMessage => ({
        role: index % 2 ? 'assistant' : 'user',
        content: index === 1 ? 'x'.repeat(400_000) : `message ${ index }`,
      })),
    ];
    const state: any = {
      messages,
      metadata: {
        action: 'direct_answer', threadId: 'cli-test', wsChannel: 'test', llmModel: '', llmLocal: false,
        cycleComplete: false, waitingForUser: false, isSubAgent: false, subAgentDepth: 0, options: {},
      },
    };

    await new InputHandlerNode(async() => cli).execute(state);

    expect(state.messages).toHaveLength(41);
    expect(state.messages[1].content).toHaveLength(400_000);
    expect(state.metadata.inputHandler).toMatchObject({
      cliManagedLoop: true,
      summaryServiceTriggered: undefined,
      tokensBefore: state.metadata.inputHandler.tokensAfter,
    });
  });
});
