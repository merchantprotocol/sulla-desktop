// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Decides whether a `visibility: "tab"` spawn really opens a visible tab, and
 * if not, why. A downgrade is never silent: the decision carries
 * `requestedVisibility` and `downgradeReason` so the spawn response and the
 * job/task record say what happened.
 *
 * When the only blocker is that the caller has no active chat thread (a hidden
 * child calling spawn_agent), the tab opens in the root human chat instead.
 */

export type TabRequestedVisibility = 'hidden' | 'tab';

export type TabDowngradeReason =
  | 'tab_launch_disabled'
  | 'agent_not_routable'
  | 'caller_is_hidden_job'
  | 'no_active_chat_thread';

export interface TabVisibilityFacts {
  requested:        TabRequestedVisibility | undefined;
  /** The caller's own chat thread, when it has one. */
  parentThreadId?:  string;
  /** True when the caller is itself a hidden job (no visible chat of its own). */
  callerIsHiddenJob: boolean;
  /** True when the selected agent resolves to an enabled routable agent. */
  agentRoutable:    boolean;
  /** Code-level switch for visible tabs (spawn_agent's allowVisibleTabs). */
  tabLaunchEnabled: boolean;
  /** Caller thread used to find the root human chat when the caller has none. */
  callerThreadId?: string;
}

export interface TabVisibilityDecision {
  visibility:           'hidden' | 'tab';
  /** Set only when a tab was requested; always 'tab' in that case. */
  requestedVisibility?: 'tab';
  /** Set only when a requested tab was downgraded to hidden. */
  downgradeReason?:     TabDowngradeReason;
  /** Thread the tab should be opened under when it differs from the caller's own thread. */
  tabParentThreadId?:   string;
}

/** Finds the root human chat thread above a caller thread (null if none). */
export interface RootChatThreadFinder {
  findRootChatThreadId(threadId: string): Promise<string | undefined>;
}

export class TabVisibilityResolver {
  constructor(private readonly rootChats: RootChatThreadFinder) {}

  async resolve(facts: TabVisibilityFacts): Promise<TabVisibilityDecision> {
    if (facts.requested !== 'tab') return { visibility: 'hidden' };

    const downgrade = (reason: TabDowngradeReason): TabVisibilityDecision => ({
      visibility: 'hidden', requestedVisibility: 'tab', downgradeReason: reason,
    });

    if (!facts.tabLaunchEnabled) return downgrade('tab_launch_disabled');
    if (!facts.agentRoutable) return downgrade('agent_not_routable');

    if (facts.parentThreadId && !facts.callerIsHiddenJob) {
      return { visibility: 'tab', requestedVisibility: 'tab' };
    }

    // The caller has no active chat of its own (a hidden child has a thread,
    // but no human is watching it). Open the tab in the root human chat when
    // one exists; the missing chat is the only blocker.
    const rootThreadId = facts.callerThreadId ? await this.rootChats.findRootChatThreadId(facts.callerThreadId) : undefined;
    if (rootThreadId) {
      return { visibility: 'tab', requestedVisibility: 'tab', tabParentThreadId: rootThreadId };
    }

    return downgrade(facts.callerIsHiddenJob ? 'caller_is_hidden_job' : 'no_active_chat_thread');
  }
}

/** Walks job parent links up to the top-level chat thread (the one with no job above it). */
export class JobLineageRootChatThreadFinder implements RootChatThreadFinder {
  constructor(private readonly findTask: (threadId: string) => Promise<{ job: { parentThreadId?: string } } | undefined>) {}

  async findRootChatThreadId(threadId: string): Promise<string | undefined> {
    const seen = new Set<string>();
    let current: string | undefined = threadId;
    while (current && !seen.has(current)) {
      seen.add(current);
      const owner = await this.findTask(current);
      if (!owner) return current;
      current = owner.job.parentThreadId;
    }
    return undefined;
  }
}
