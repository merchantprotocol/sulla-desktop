// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AsyncLocalStorage } from 'node:async_hooks';
import { BaseTool, type ToolResponse } from '../base';
import type { DecisionAgentAction, DecisionResponse } from '@pkg/shared/decisions';
import { decisionService } from '../../services/DecisionService';

/** Current-call identity comes from an active graph invocation or verified tool session only. */
export class AnswerDecisionWorker extends BaseTool {
  name = '';
  description = '';
  schemaDef = {
    decisionId: { type: 'string' as const, description: 'The decision id from the holder notification.' },
    action: { type: 'enum' as const, enum: ['answer', 'pass', 'deny'], description: 'Answer or pass a plain question; deny or pass an approval.' },
    answers: { type: 'array' as const, optional: true, items: { type: 'object' as const, properties: {
      question: { type: 'string' as const }, selected: { type: 'array' as const, items: { type: 'string' as const } },
    } } },
    note: { type: 'string' as const, optional: true, description: 'A short plain-text pass or denial note (stored up to 500 characters).' },
  };

  private readonly invocationThread = new AsyncLocalStorage<string>();

  override async invoke(input: unknown, state?: any) {
    const threadId = state?.metadata?.threadId;
    if (typeof threadId !== 'string' || !threadId.trim()) {
      return { toolName: this.name, success: false, error: 'agents/answer_decision requires a verified tool session.' };
    }
    return this.invocationThread.run(threadId.trim(), () => super.invoke(input, state));
  }

  override async call(rawInput: unknown) {
    const threadId = this.invocationThread.getStore();
    if (!threadId || (this.executionContext?.thread_id && this.executionContext.thread_id !== threadId)) {
      return { toolName: this.name, success: false, error: 'agents/answer_decision requires a verified tool session.' };
    }
    return super.call(rawInput);
  }

  /** The authenticated CLI dispatch passes its resolved session thread per call, never via shared worker state. */
  async callWithVerifiedSession(threadId: string | undefined, rawInput: unknown) {
    if (typeof threadId !== 'string' || !threadId.trim()) {
      return { toolName: this.name, success: false, error: 'agents/answer_decision requires a verified tool session.' };
    }
    return this.invocationThread.run(threadId.trim(), () => this.call(rawInput));
  }

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const threadId = this.invocationThread.getStore();
    if (!threadId) return { successBoolean: false, responseString: 'A verified tool session is required.' };
    const decisionId = String(input.decisionId ?? '').trim();
    if (!decisionId || decisionId.length > 300) return { successBoolean: false, responseString: 'A valid decisionId is required.' };
    const action = input.action as DecisionAgentAction;
    const answers = Array.isArray(input.answers) ? input.answers as DecisionResponse['answers'] : undefined;
    const note = typeof input.note === 'string' ? input.note : undefined;
    const outcome = await decisionService.answerAsAgent(threadId, decisionId, action, answers, note);
    return {
      successBoolean: outcome.settled,
      responseString: outcome.settled
        ? action === 'answer' ? 'Decision answered.' : action === 'deny' ? 'Approval denied.' : 'Decision passed to the next holder.'
        : outcome.reason ?? 'Decision could not be changed.',
    };
  }
}
