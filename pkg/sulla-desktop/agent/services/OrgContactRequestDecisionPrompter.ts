// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ContactRequestChoice, MessageEnvelope } from '@sulla/domain';
import { decisionService } from './DecisionService';
import type { OrgContactRequestPrompter } from './OrgMessenger';
import { emitQuestionCardViaWs } from '../tools/meta/askUserQuestionShared';

/** Reuses the existing durable Ask/Decide question surface; no org-specific UI is introduced. */
export class OrgContactRequestDecisionPrompter implements OrgContactRequestPrompter {
  private readonly active = new Map<string, Promise<void>>();
  private readonly choices: Readonly<Record<string, ContactRequestChoice>> = {
    'Allow always': 'allow_always',
    'Just this once': 'just_this_once',
    Block: 'block',
  };

  request(senderUserId: string, messages: readonly MessageEnvelope[], resolve: (choice: ContactRequestChoice) => Promise<readonly number[]>): Promise<void> {
    const key = `${messages[0]?.data.orgId ?? ''}:${senderUserId}`;
    const existing = this.active.get(key);
    if (existing) return existing;
    const pending = this.ask(senderUserId, messages, resolve).finally(() => this.active.delete(key));
    this.active.set(key, pending);
    return pending;
  }

  private async ask(senderUserId: string, messages: readonly MessageEnvelope[], resolve: (choice: ContactRequestChoice) => Promise<readonly number[]>): Promise<void> {
    const first = messages[0];
    if (!first) return;
    const questions = [{
      question: `A teammate's agent wants to contact you. Allow it to use your agent's access?`,
      options: [
        { label: 'Allow always', description: 'Allow future messages from this person.' },
        { label: 'Just this once', description: 'Allow only these held messages.' },
        { label: 'Block', description: 'Do not deliver these messages.' },
      ],
    }];
    const { record, result } = await decisionService.request({
      kind: 'question',
      title: `First contact from organization member ${senderUserId}`,
      questions,
      channel: 'sulla-desktop',
      conversationId: first.data.conversationId,
    }, 30 * 60_000);
    const sent = await emitQuestionCardViaWs('sulla-desktop', first.data.conversationId, record.id, questions);
    if (!sent) {
      await decisionService.expire(record.id);
      await resolve('block');
      return;
    }
    const answer = await result;
    const selected = answer.status === 'answered' ? answer.answers[0]?.selected[0] : undefined;
    await resolve((selected && this.choices[selected]) || 'block');
  }
}
