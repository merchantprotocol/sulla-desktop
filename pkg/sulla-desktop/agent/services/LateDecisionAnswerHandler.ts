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
  settled: boolean;
  conversationId: string;
  late: true;
  closed?: boolean;
  reason?: string;
}

/** Queue one decision-keyed human answer in the existing durable mailbox.
 * The original running turn is preserved; its normal inbox drain handles the answer.
 * A committed queue receipt survives a process interruption before the wake signal.
 */
export class LateDecisionAnswerHandler {
  constructor(
    private readonly decisions: Pick<PendingDecisionRepository, 'queueLateAnswer' | 'findById'>,
    private readonly conversations: LateAnswerConversationRepository,
    private readonly sender: LateAnswerMessageSender,
  ) {}

  async handle(record: DecisionRecord, response: DecisionResponse): Promise<LateAnswerReceipt> {
    if (response.action !== 'answered' || response.conversationId !== record.conversationId) throw new Error('Answer is not for this conversation');
    const answers = this.validateAnswers(record, response.answers);
    if (!answers) throw new Error('Answer could not be recorded.');
    const conversation = await this.conversations.find(record.conversationId);
    if (!conversation) {
      return { settled: true, conversationId: record.conversationId, late: true, closed: true, reason: 'The original chat is no longer available. Your request is still here; dismiss it when you no longer need it.' };
    }
    const answerText = answers.map(answer => `${ answer.question }: ${ answer.selected.join(', ') }`).join('; ');
    const body = `My answers to your earlier question "${ record.title }": ${ answerText }`;
    const queued = await this.decisions.queueLateAnswer(record, answers, body);
    if (!queued) {
      const existing = await this.decisions.findById(record.id);
      if (existing && ['queued', 'processing', 'delivered'].includes(existing.answerDelivery ?? '')) return { settled: true, conversationId: record.conversationId, late: true, reason: 'Answer queued in the original chat.' };
      return { settled: false, conversationId: record.conversationId, late: true, reason: 'This request changed. Refresh For You before answering.' };
    }
    // Wake is best effort: the existing durable inbox also replays after restart.
    await this.sender.send(record.channel, { type: 'decision_answer_queued', data: { decisionId: record.id } }).catch(() => false);
    return { settled: true, conversationId: record.conversationId, late: true, reason: 'Answer queued in the original chat.' };
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
