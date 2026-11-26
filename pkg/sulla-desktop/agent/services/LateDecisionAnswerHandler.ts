// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';
import type { AgentJobTaskTarget } from '../database/models/AgentJobMessagingModel';
import { DecisionAnswererLabel } from './DecisionAnswererLabel';

export interface LateAnswerConversationRepository {
  find(conversationId: string): Promise<{ id: string } | null>;
}

export interface LateAnswerMessageSender {
  send(channel: string, message: { type: string; data: Record<string, unknown> }): Promise<boolean>;
}

export interface LateAnswerJobMessageSender {
  send(jobId: string, taskIndex: number, message: string): Promise<boolean>;
}

interface LateAnswerDecisionRepository {
  queueLateAnswer(record: DecisionRecord, answers: { question: string; selected: string[] }[], body: string): Promise<DecisionRecord | undefined>;
  findById(id: string): Promise<DecisionRecord | undefined>;
  taskForThread?(threadId: string): Promise<AgentJobTaskTarget | null>;
  recordJobAnswer?(record: DecisionRecord, answers: { question: string; selected: string[] }[]): Promise<DecisionRecord | undefined>;
  markJobAnswerUnavailable?(id: string): Promise<void>;
  markJobAnswerDelivered(id: string): Promise<boolean>;
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
  private readonly answererLabels = new DecisionAnswererLabel();

  constructor(
    private readonly decisions: LateAnswerDecisionRepository,
    private readonly conversations: LateAnswerConversationRepository,
    private readonly sender: LateAnswerMessageSender,
    private readonly jobMessages: LateAnswerJobMessageSender = new SullaLateAnswerJobMessageSender(),
  ) {}

  async handle(record: DecisionRecord, response: DecisionResponse): Promise<LateAnswerReceipt> {
    if (response.action !== 'answered' || response.conversationId !== record.conversationId) throw new Error('Answer is not for this conversation');
    const answers = this.validateAnswers(record, response.answers);
    if (!answers) throw new Error('Answer could not be recorded.');
    const actor = record.answeredBy ?? { kind: 'human' as const };
    const answerText = answers.map(answer => `${ answer.question }: ${ answer.selected.join(', ') }`).join('; ');
    const envelope = `[Decision answered by ${ this.answererLabels.label(actor) ?? 'agent' }]\n${ record.title }\n${ answerText }`;
    const body = actor.kind === 'human' ? `My answers to your earlier question "${ record.title }": ${ answerText }` : envelope;
    const asker = await this.decisions.taskForThread?.(record.conversationId);
    const jobId = record.payload?.askerJobId ?? asker?.jobId;
    const taskIndex = Number(record.payload?.askerTaskIndex ?? asker?.taskIndex);
    if (jobId && Number.isInteger(taskIndex) && taskIndex >= 0) return this.handleJobAnswer(record, answers, envelope, jobId, taskIndex, asker);
    const conversation = await this.conversations.find(record.conversationId);
    if (!conversation) {
      return { settled: true, conversationId: record.conversationId, late: true, closed: true, reason: 'The original chat is no longer available. Your request is still here; dismiss it when you no longer need it.' };
    }
    const queued = await this.decisions.queueLateAnswer(record, answers, body);
    if (!queued) {
      const existing = await this.decisions.findById(record.id);
      if (existing && ['queued', 'processing', 'delivered', 'unavailable'].includes(existing.answerDelivery ?? '') && this.isSameAnswer(existing, actor, answers)) return { settled: true, conversationId: record.conversationId, late: true, reason: existing.answerDelivery === 'unavailable' ? 'The answer is recorded, but its original asker is no longer available.' : 'Answer queued in the original chat.' };
      return { settled: false, conversationId: record.conversationId, late: true, reason: 'This request changed. Refresh For You before answering.' };
    }
    // Wake is best effort: the existing durable inbox also replays after restart.
    await this.sender.send(record.channel, { type: 'decision_answer_queued', data: { decisionId: record.id } }).catch(() => false);
    return { settled: true, conversationId: record.conversationId, late: true, reason: 'Answer queued in the original chat.' };
  }

  private async handleJobAnswer(record: DecisionRecord, answers: { question: string; selected: string[] }[], body: string,
    jobId: string, taskIndex: number, asker: AgentJobTaskTarget | null | undefined): Promise<LateAnswerReceipt> {
    if (!this.decisions.recordJobAnswer) throw new Error('Decision repository cannot record delegated answers.');
    const saved = await this.decisions.recordJobAnswer(record, answers);
    if (!saved) {
      const existing = await this.decisions.findById(record.id);
      const actor = record.answeredBy ?? { kind: 'human' as const };
      if (existing && ['queued', 'processing', 'delivered', 'unavailable'].includes(existing.answerDelivery ?? '') && this.isSameAnswer(existing, actor, answers)) {
        return { settled: true, conversationId: record.conversationId, late: true, reason: existing.answerDelivery === 'unavailable' ? 'The answer is recorded, but its original asker is no longer available.' : 'Answer is already queued in the delegated task mailbox.' };
      }
      return { settled: false, conversationId: record.conversationId, late: true, reason: 'This request changed. Refresh For You before answering.' };
    }
    if (asker && (asker.jobId !== jobId || asker.taskIndex !== taskIndex || !['running', 'parked'].includes(asker.jobStatus) || !['running', 'parked'].includes(asker.taskStatus))) {
      await this.decisions.markJobAnswerUnavailable?.(record.id);
      return { settled: true, conversationId: record.conversationId, late: true, reason: 'The answer is recorded, but the asker has finished or stopped; its task cannot be woken.' };
    }
    if (!await this.jobMessages.send(jobId, taskIndex, body)) {
      await this.decisions.markJobAnswerUnavailable?.(record.id);
      return { settled: true, conversationId: record.conversationId, late: true, reason: 'The answer is recorded, but the delegated task is no longer available to receive it.' };
    }
    await this.decisions.markJobAnswerDelivered(record.id);
    return { settled: true, conversationId: record.conversationId, late: true, reason: 'Answer queued in the delegated task mailbox.' };
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

  private isSameAnswer(record: DecisionRecord, actor: NonNullable<DecisionRecord['answeredBy']>, answers: { question: string; selected: string[] }[]): boolean {
    const savedActor = record.answeredBy;
    if (!savedActor || savedActor.kind !== actor.kind) return false;
    if (actor.kind === 'agent' && (savedActor.kind !== 'agent' || savedActor.threadId !== actor.threadId || savedActor.agentId !== actor.agentId)) return false;
    return JSON.stringify(record.answers ?? []) === JSON.stringify(answers);
  }
}

class SullaLateAnswerJobMessageSender implements LateAnswerJobMessageSender {
  async send(jobId: string, taskIndex: number, message: string): Promise<boolean> {
    const { sendJobMessage } = await import('../tools/agents/send_job_message');
    return (await sendJobMessage({ jobId, taskIndex, message })).successBoolean;
  }
}
