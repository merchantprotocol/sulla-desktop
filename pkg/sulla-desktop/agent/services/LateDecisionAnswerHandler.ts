// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';
import type { PendingDecisionRepository } from '../repositories/PendingDecisionRepository';

export interface LateAnswerConversationRepository {
  find(conversationId: string): Promise<{ id: string } | null>;
}

export interface LateAnswerMessageSender {
  send(channel: string, message: { type: string; data: Record<string, unknown> }): Promise<boolean>;
}

export interface LateAnswerReceipt {
  settled: true;
  conversationId: string;
  late: true;
  closed?: boolean;
  reason?: string;
}

/** Delivers a post-timeout question answer exactly once without reviving the parked tool. */
export class LateDecisionAnswerHandler {
  constructor(
    private readonly decisions: Pick<PendingDecisionRepository, 'claimLateAnswer'>,
    private readonly conversations: LateAnswerConversationRepository,
    private readonly sender: LateAnswerMessageSender,
  ) {}

  async handle(record: DecisionRecord, response: DecisionResponse): Promise<LateAnswerReceipt> {
    if (response.action !== 'answered' || response.conversationId !== record.conversationId) throw new Error('Answer is not for this conversation');
    const answers = this.validateAnswers(record, response.answers);
    if (!answers) throw new Error('Answer could not be recorded.');
    const conversation = await this.conversations.find(record.conversationId);
    if (!conversation) {
      return { settled: true, conversationId: record.conversationId, late: true, closed: true, reason: 'Question closed; the original conversation no longer exists.' };
    }
    if (!await this.decisions.claimLateAnswer(record.id)) {
      return { settled: true, conversationId: record.conversationId, late: true, reason: 'answered late — sent as a new message' };
    }
    const answerText = answers.map(answer => `${ answer.question }: ${ answer.selected.join(', ') }`).join('; ');
    await this.sender.send(record.channel, {
      type: 'assistant_message',
      data: {
        content: `Late answer to ${ record.title }: ${ answerText }`,
        role: 'user',
        kind: 'notice',
        thread_id: record.conversationId,
        timestamp: Date.now(),
      },
    });
    return { settled: true, conversationId: record.conversationId, late: true, reason: 'answered late — sent as a new message' };
  }

  private validateAnswers(record: DecisionRecord, answers: DecisionResponse['answers']): { question: string; selected: string[] }[] | null {
    const questions = record.questions ?? [];
    if (!Array.isArray(answers) || answers.length !== questions.length) return null;
    const normalized = answers.map((answer, index) => {
      const selected = answer?.selected;
      const question = questions[index];
      if (!Array.isArray(selected) || !selected.length || (!question.multiSelect && selected.length !== 1) ||
        selected.some(value => typeof value !== 'string' || !value.trim() || value.length > 10000)) return null;
      return { question: question.question, selected: selected.map(value => value.trim()) };
    });
    return normalized.every(Boolean) ? normalized as { question: string; selected: string[] }[] : null;
  }
}
