// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord } from '@pkg/shared/decisions';
import type { ToolDecisionPort } from './toolDecisionPort';

/** One policy lookup and at most one generic Decide request per invocation. No arguments enter the inbox. */
export class ToolApprovalGate {
  constructor(private readonly decisions: ToolDecisionPort) {}

  async check(input: {
    name: string; category: string; conversationId?: string; channel?: string; signal?: AbortSignal;
    requiredByRelay?: boolean; onPending?: (record: DecisionRecord) => Promise<void>;
  }) {
    const { name, signal } = input;
    signal?.throwIfAborted();
    if (name === 'ask_user_question' || (!input.requiredByRelay && !await this.decisions.requiresApproval(name))) return;
    const { record, result } = await this.decisions.request({
      kind: 'approval',
      title: `Allow ${ input.category } / ${ name }?`,
      toolName: name,
      conversationId: input.conversationId || '',
      channel: input.channel || '',
    }, undefined, signal);
    try { await input.onPending?.(record); } catch { /* The durable Decide inbox remains available. */ }
    return { record, answer: await result };
  }
}
