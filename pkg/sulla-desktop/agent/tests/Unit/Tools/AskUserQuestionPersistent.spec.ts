// SPDX-License-Identifier: GPL-2.0-or-later
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/agent/tools/base', () => ({ BaseTool: class {} }));
const f = vi.hoisted(() => ({ requestQuestion: vi.fn(), emit: vi.fn() }));
vi.mock('@pkg/agent/services/DecisionService', () => ({ decisionService: { requestQuestion: f.requestQuestion } }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({ getWebSocketClientService: vi.fn() }));

import { AskUserQuestionWorker } from '@pkg/agent/tools/meta/ask_user_question';
import { QuestionReceiptPolicy } from '@pkg/agent/tools/meta/askUserQuestionShared';
const questions = [{ question: 'Choose?', options: [{ label: 'A' }, { label: 'B' }] }];
function worker(): any { const value = new AskUserQuestionWorker() as any; value.state = { metadata: { threadId: 'tool-thread', wsChannel: 'sulla-desktop' } }; value.emitMessage = f.emit; return value }
beforeEach(() => { vi.clearAllMocks(); f.requestQuestion.mockResolvedValue({ record: { id: 'tool-question' }, reused: false }); f.emit.mockResolvedValue(true) });
describe('the in-process question tool', () => {
  it('offers parent answering only when a live agent appears in the resolved chain', () => {
    // risk: user guidance — a top-level agent must not be told a nonexistent launch parent can answer.
    const policy = new QuestionReceiptPolicy();

    expect(policy.parentMayAnswer({})).toBe(false);
    expect(policy.parentMayAnswer({ route: { authority: 'any', chain: [{ kind: 'human' }], holderIndex: 0 } as any })).toBe(false);
    expect(policy.parentMayAnswer({ route: { authority: 'any', chain: [{ kind: 'agent' }, { kind: 'human' }], holderIndex: 0 } as any })).toBe(true);
  });

  it('saves a persistent question without waiting on the old timeout', async() => {
    const result = await worker()._validatedCall({ questions, timeoutMs: 1 });
    expect(result.successBoolean).toBe(true);
    expect(result.responseString).toContain('tool-question');
    expect(result.responseString).toContain('remains open until answered or dismissed');
    expect(f.requestQuestion).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'tool-thread', questions: [expect.objectContaining({ question: 'Choose?', options: questions[0].options })] }), undefined);
  });
  it('does not emit a second card for an exact repeat', async() => {
    f.requestQuestion.mockResolvedValue({ record: { id: 'tool-question' }, reused: true });
    await worker()._validatedCall({ questions }); expect(f.emit).not.toHaveBeenCalled();
  });
  it('keeps the saved receipt if transcript notification fails', async() => {
    f.emit.mockResolvedValue(false);
    expect((await worker()._validatedCall({ questions })).responseString).toContain('For You');
  });
  it('rejects malformed questions before creating a durable record', async() => {
    expect((await worker()._validatedCall({ questions: [] })).successBoolean).toBe(false);
    expect(f.requestQuestion).not.toHaveBeenCalled();
  });
});
