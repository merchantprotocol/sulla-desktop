// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';

/** Finds the visible root conversation for an escalated card, not its hidden requester thread. */
export class DecisionConversationTargetResolver {
  resolve(record: DecisionRecord): string {
    const humanRoot = record.route?.chain.filter(entry => entry.kind === 'human').at(-1)?.threadId;
    if (humanRoot) return humanRoot;

    const related = record.relatedConversationIds ?? [];
    const routeThreads = new Set(record.route?.chain.map(entry => entry.threadId) ?? []);
    const rootCandidates = related.filter(id => id !== record.conversationId && !routeThreads.has(id));
    return rootCandidates.at(-1) ?? related.filter(id => id !== record.conversationId).at(-1) ?? record.conversationId;
  }
}
