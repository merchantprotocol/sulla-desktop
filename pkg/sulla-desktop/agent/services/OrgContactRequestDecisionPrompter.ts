// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { ContactRequestChoice } from '@sulla/domain';
import type { OrgContactPrompt, OrgContactPromptOutcome, OrgContactRequestPrompter } from './OrgMessenger';

interface ContactQuestion {
  question: string;
  options: { label: string; description: string }[];
}

/** The slice of DecisionService the prompter needs; injected so the trust decision is testable. */
export interface ContactDecisionStore {
  request(input: { kind: 'question'; title: string; questions: ContactQuestion[]; channel: string; conversationId: string }, timeoutMs: number): Promise<{
    record: { id: string };
    result: Promise<{ status: string; answers: { selected: string[] }[] }>;
  }>;
  expire(id: string): Promise<void>;
}

export interface ContactQuestionCardEmitter {
  emit(channel: string, conversationId: string, questionId: string, questions: ContactQuestion[]): Promise<boolean>;
}

class DesktopContactDecisionStore implements ContactDecisionStore {
  async request(input: Parameters<ContactDecisionStore['request']>[0], timeoutMs: number) {
    const { decisionService } = await import('./DecisionService');
    return decisionService.request(input as any, timeoutMs) as any;
  }

  async expire(id: string): Promise<void> {
    const { decisionService } = await import('./DecisionService');
    await decisionService.expire(id);
  }
}

class DesktopContactQuestionCardEmitter implements ContactQuestionCardEmitter {
  async emit(channel: string, conversationId: string, questionId: string, questions: ContactQuestion[]): Promise<boolean> {
    const { emitQuestionCardViaWs } = await import('../tools/meta/askUserQuestionShared');
    return emitQuestionCardViaWs(channel, conversationId, questionId, questions as any);
  }
}

/**
 * Reuses the existing durable Ask/Decide question surface; no org-specific UI is introduced.
 *
 * Trust rule: only an explicit human click resolves a held contact request. A card that
 * cannot be shown, expires, or is dismissed changes nothing — the request stays held on
 * the host and the messenger may ask again later.
 */
export class OrgContactRequestDecisionPrompter implements OrgContactRequestPrompter {
  private readonly active = new Map<string, Promise<OrgContactPromptOutcome>>();
  private readonly choices: Readonly<Record<string, ContactRequestChoice>> = {
    'Allow always': 'allow_always',
    'Just this once': 'just_this_once',
    Block: 'block',
  };

  constructor(
    private readonly decisions: ContactDecisionStore = new DesktopContactDecisionStore(),
    private readonly cards: ContactQuestionCardEmitter = new DesktopContactQuestionCardEmitter(),
    private readonly channel = 'sulla-desktop',
    private readonly timeoutMs = 30 * 60_000,
  ) {}

  request(prompt: OrgContactPrompt): Promise<void> {
    const key = `${prompt.messages[0]?.data.orgId ?? ''}:${prompt.senderUserId}`;
    const existing = this.active.get(key);
    if (existing) return Promise.resolve();
    const pending = this.ask(prompt).catch(error => {
      console.warn('[OrgContactRequest] Prompt did not complete; request remains held:', error);
      return 'unanswered' as const;
    }).finally(() => this.active.delete(key));
    this.active.set(key, pending);
    // Scheduling the human interaction must not hold up sync/outbox/inbox work.
    return Promise.resolve();
  }

  private async ask(prompt: OrgContactPrompt): Promise<OrgContactPromptOutcome> {
    const first = prompt.messages[0];
    if (!first) return 'unanswered';
    const questions: ContactQuestion[] = [{
      question: `${prompt.senderName}'s agent wants to contact you${prompt.orgName ? ` in ${prompt.orgName}` : ''}. Allow it to use your agent's access?`,
      options: [
        { label: 'Allow always', description: `Allow future messages from ${prompt.senderName}.` },
        { label: 'Just this once', description: 'Allow only these held messages.' },
        { label: 'Block', description: 'Do not deliver these messages.' },
      ],
    }];
    const { record, result } = await this.decisions.request({
      kind: 'question',
      title: `First contact from ${prompt.senderName}${prompt.orgName ? ` (${prompt.orgName})` : ''}`,
      questions,
      channel: this.channel,
      conversationId: first.data.conversationId,
      payload: { decisionAuthority: 'human' },
    }, this.timeoutMs);
    const shown = await this.cards.emit(this.channel, first.data.conversationId, record.id, questions);
    if (!shown) {
      await this.decisions.expire(record.id);
      return 'unsent';
    }
    await prompt.shown();
    const answer = await result;
    const selected = answer.status === 'answered' ? answer.answers[0]?.selected[0] : undefined;
    const choice = selected ? this.choices[selected] : undefined;
    if (!choice) return 'unanswered';
    await prompt.resolve(choice);
    return 'answered';
  }
}
