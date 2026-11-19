// SPDX-License-Identifier: GPL-2.0-or-later
import type { DecisionRecord } from './decisions';

/** Presentation lifetime is independent of an execution wait's deadline. */
export class DecisionAttention {
  /** Retain expired duplicate forms as history without sending or copying an answer. */
  static present(records: DecisionRecord[]): DecisionRecord[] {
    const saved = records.filter(record => record.kind === 'question' && record.questions?.length &&
      (record.attention === 'answered' || record.status === 'answered' || Boolean(record.answerDelivery)) &&
      record.questions.every(question => !question.task && !question.command &&
        record.answers?.some(answer => answer.question === question.question && answer.selected.length > 0)))
      .sort((a, b) => b.createdAt - a.createdAt);
    return records.map(record => {
      if (record.kind !== 'question' || record.status !== 'expired' || !this.active(record) ||
        record.answers?.length || !record.questions?.length || record.questions.some(question => question.task || question.command)) return record;
      const newer = saved.find(candidate => candidate.createdAt > record.createdAt &&
        candidate.conversationId === record.conversationId && candidate.channel === record.channel &&
        this.questionKey(candidate) === this.questionKey(record));
      return newer ? { ...record, supersededBy: newer.id } : record;
    });
  }

  private static questionKey(record: DecisionRecord): string {
    return JSON.stringify([record.title, record.questions?.map(question => [question.question, question.header ?? '',
      Boolean(question.multiSelect), question.options.map(option => [option.label, option.description ?? ''])])]);
  }

  static active(record: DecisionRecord, now = Date.now()): boolean {
    if (record.supersededBy) return false;
    if (['answered', 'approved', 'denied'].includes(record.status) || record.attention === 'dismissed' || record.attention === 'answered' || String(record.payload?.lateAnswerDelivered) === 'true') return false;
    if (record.kind === 'question') return record.attention === 'active' || ['pending', 'deferred'].includes(record.status);
    return ['pending', 'deferred'].includes(record.status) && record.expiresAt > now;
  }

  static label(record: DecisionRecord, now = Date.now()): string {
    if (record.supersededBy) return 'Duplicate request';
    if (record.status === 'approved') return 'Approved';
    if (record.status === 'denied') return 'Denied';
    if (record.answerDelivery === 'interrupted') return 'Answer delivery interrupted';
    if (record.attention === 'dismissed') return 'Dismissed';
    if (record.answerDelivery === 'processing') return 'Delivering answer';
    if (record.answerDelivery === 'queued') return 'Answer queued';
    if (record.answerDelivery === 'delivered') return 'Answered';
    if (record.attention === 'answered' || record.status === 'answered') return 'Answered';
    if (this.active(record, now)) return record.kind === 'approval' ? 'Approval needed' : 'Needs your answer';
    return record.kind === 'approval' ? 'Approval closed' : 'No answer recorded';
  }
}
