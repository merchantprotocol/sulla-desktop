// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import type { DecisionRecord } from '@pkg/shared/decisions';
import { DecisionConversationTargetResolver } from './DecisionConversationTargetResolver';
import { DecisionRoutePresenter } from './DecisionRoutePresenter';

const now = Date.UTC(2026, 10, 25, 15, 0);
const deadline = Date.UTC(2026, 10, 25, 15, 25);
const presenter = new DecisionRoutePresenter({ now: () => now });

function record(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    id: 'decision-1', conversationId: 'root', channel: 'sulla', title: 'Pick a path?', kind: 'question',
    status: 'pending', createdAt: Date.UTC(2026, 10, 25, 14, 19), expiresAt: Date.UTC(2026, 10, 25, 15, 40),
    requestedBy: { agentId: 'codex-luna-worker' },
    route: {
      authority: 'any',
      chain: [
        { threadId: 'manager', channel: 'codex', agentId: 'coding-manager', kind: 'agent' },
        { threadId: 'sulla', channel: 'sulla', agentId: 'sulla', kind: 'agent' },
        { threadId: 'root', channel: 'sulla', agentId: 'human', kind: 'human' },
      ],
      holderIndex: 0,
      holderSince: Date.UTC(2026, 10, 25, 14, 22),
      holderDeadline: deadline,
      history: [],
    },
    ...overrides,
  };
}

describe('DecisionRoutePresenter', () => {
  it('labels the current holder and remaining three-level chain', () => {
    // risk: consent visibility — the human must see which agent has the choice and who receives it next.
    const view = presenter.present(record());
    expect(view.holderLabel).toBe('Coding Manager');
    expect(view.holderLine).toBe('With Coding Manager until 3:25 PM');
    expect(view.secondaryLine).toBe('· then Sulla, then you');
    expect(view.trail[0]).toMatchObject({ time: '2:19 PM', actorLabel: 'Codex Luna Worker', actorInitial: 'L', actionLabel: 'asked' });
    expect(view.trail[1]).toMatchObject({ time: 'now', actorLabel: 'Coding Manager', actionLabel: 'With Coding Manager until 3:25 PM', current: true });
    const labeled = record({ route: { ...record().route!, chain: [{ ...record().route!.chain[0], label: 'Product Lead' }, ...record().route!.chain.slice(1)] as any } });
    expect(presenter.present(labeled).holderLabel).toBe('Product Lead');
  });

  it('formats a holder deadline as a localized hour and minute', () => {
    // risk: time accuracy — a wrong lease time can make an escalation appear stuck or prematurely urgent.
    const expected = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(deadline));
    expect(presenter.present(record()).holderLine).toBe(`With Coding Manager until ${expected}`);
  });

  it('classifies human-held, agent-held, and settled records', () => {
    // risk: authorization — an agent-held decision is surfaced separately while human controls stay available.
    const humanHeld = record({ route: { ...record().route!, holderIndex: 2 } });
    const agentHeld = record();
    const settled = record({ status: 'answered', answeredBy: { kind: 'human' } });
    expect(presenter.present(humanHeld).turn).toBe('yours');
    expect(presenter.present(agentHeld).turn).toBe('with-agent');
    expect(presenter.present(settled).turn).toBe('settled');
  });

  it('keeps records without a route on the legacy presentation path', () => {
    // risk: backwards compatibility — older decisions must not acquire escalation UI or invented trail data.
    const view = presenter.present(record({ route: undefined }));
    expect(view.hasRoute).toBe(false);
    expect(view.trail).toEqual([]);
  });

  it('attributes settled answers to the actual human or agent', () => {
    // risk: actor attribution — users must know when an agent settled a decision instead of them.
    const answered = record({
      status: 'answered',
      answeredBy: { kind: 'agent', agentId: 'coding-manager' },
      answers: [{ question: 'Pick a path?', selected: ['Option A', 'Option C'] }],
      route: { ...record().route!, history: [{ threadId: 'manager', agentId: 'coding-manager', action: 'answered', at: deadline }] },
    });
    const human = record({ status: 'answered', answeredBy: { kind: 'human' } });
    expect(presenter.present(answered).answeredByLabel).toBe('Answered by Coding Manager');
    expect(presenter.present(answered).answerSummary).toBe('Option A, Option C');
    expect(presenter.present(human).answeredByLabel).toBe('Answered by you');
  });

  it('uses the signed-in human name for initials and falls back to You with Y', () => {
    // risk: actor attribution — human-held and human-history rows must identify the signed-in user without a hardcoded person.
    const namedPresenter = new DecisionRoutePresenter({ now: () => now }, () => 'Jonathon Byrdziak');
    const humanAction = record({ route: {
      ...record().route!,
      holderIndex: 2,
      history: [{ threadId: 'root', agentId: 'human', action: 'passed', at: deadline }],
    } });
    const namedView = namedPresenter.present(humanAction);
    expect(namedView.holderInitial).toBe('J');
    expect(namedView.trail[1]).toMatchObject({ actorLabel: 'Jonathon Byrdziak', actorInitial: 'J' });

    const fallbackView = presenter.present(record({ route: {
      ...record().route!,
      holderIndex: 2,
      history: [{ threadId: 'root', agentId: 'human', action: 'passed', at: deadline }],
    } }));
    expect(fallbackView.holderInitial).toBe('Y');
    expect(fallbackView.trail[1]).toMatchObject({ actorLabel: 'You', actorInitial: 'Y' });
  });

  it('sanitizes untrusted history notes to plain text without markdown or links', () => {
    // risk: untrusted input — agent notes must not render markdown, links, or HTML in a decision card.
    const routed = record({
      route: { ...record().route!, history: [{
        threadId: 'manager', agentId: 'coding-manager', action: 'passed', at: deadline,
        note: '**See [details](https://example.test) and https://unsafe.test**\n> move ahead <img src=x>',
      }] },
    });
    expect(presenter.present(routed).trail[1]).toMatchObject({ time: '3:25 PM', actorLabel: 'Coding Manager', actorInitial: 'C', actionLabel: 'passed it up after 1h 6m', note: 'See details and move ahead' });
  });
});

describe('DecisionConversationTargetResolver', () => {
  const resolver = new DecisionConversationTargetResolver();

  it('opens the human root chat for a decision raised in a hidden sub-agent thread', () => {
    // risk: answerability — the visible root transcript must load the actionable decision card, not the hidden requester thread.
    const routed = record({
      conversationId: 'hidden-subagent',
      relatedConversationIds: ['hidden-subagent'],
      route: { ...record().route!, chain: [
        { threadId: 'parent-agent', channel: 'codex', agentId: 'coding-manager', kind: 'agent' },
        { threadId: 'root', channel: 'sulla', agentId: 'human', kind: 'human' },
      ] },
    });
    expect(resolver.resolve(routed)).toBe('root');
  });

  it('uses a related root when an older routed record has no human chain entry', () => {
    // risk: answerability — related conversations keep escalated records reachable when route metadata is partial.
    const partialRoute = record({ conversationId: 'hidden-subagent', route: {
      ...record().route!,
      chain: [{ threadId: 'parent-agent', channel: 'codex', agentId: 'coding-manager', kind: 'agent' }],
    } });
    expect(resolver.resolve({ ...partialRoute, relatedConversationIds: ['hidden-subagent', 'root'] })).toBe('root');
  });

  it('keeps the original target for legacy records with no route ancestry', () => {
    // risk: compatibility — old records without escalation metadata still open their original conversation.
    expect(resolver.resolve(record({ conversationId: 'legacy-conversation', route: undefined, relatedConversationIds: undefined }))).toBe('legacy-conversation');
  });
});
