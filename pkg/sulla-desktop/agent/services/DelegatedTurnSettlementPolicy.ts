// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type DelegatedTurnSettlement = 'terminal' | 'child_park' | 'wait_park' | 'remind' | 'fail';
export class DelegatedTurnSettlementPolicy {
  decide(input: { returned: boolean; openChildren: number; pendingWait: boolean; reminderSent: boolean }): DelegatedTurnSettlement {
    if (input.returned) return 'terminal';
    if (input.openChildren > 0) return 'child_park';
    if (input.pendingWait) return 'wait_park';
    return input.reminderSent ? 'fail' : 'remind';
  }

  private readonly maxFailureCauseLength = 2_000;
  private readonly injectedContextPattern = /\n*<(?:[a-z_]+_observations|[a-z_]+_context|observational_memory|routine_digest|lane_health|citations|system-reminder)>[\s\S]*?<\/(?:[a-z_]+_observations|[a-z_]+_context|observational_memory|routine_digest|lane_health|citations|system-reminder)>/g;

  private realAssistantText(content: unknown): string {
    const text = typeof content === 'string' ? content : JSON.stringify(content ?? '');
    return text.replace(this.injectedContextPattern, '').trim();
  }

  failureCause(finalState: any): string {
    const messages = Array.isArray(finalState?.messages) ? [...finalState.messages].reverse() : [];
    for (const assistant of messages) {
      if (assistant?.role !== 'assistant') continue;
      const content = this.realAssistantText(assistant.content);
      const toolCalls = assistant.tool_calls ?? assistant.toolCalls;
      if (!content && !toolCalls) continue;
      const cause = toolCalls
        ? `${ content || '(empty assistant text)' }\nTool call: ${ JSON.stringify(toolCalls) }`
        : content;
      return cause.slice(0, this.maxFailureCauseLength);
    }
    return '(no assistant output was recorded)';
  }
}
export class MissingContractAfterReminderError extends Error {
  readonly code = 'missing_contract_after_reminder';
  constructor(causeText: string) { super(`missing_contract_after_reminder: delegated worker ended twice without returning its contract. Last assistant output/tool call:\n${ causeText }`); this.name = 'MissingContractAfterReminderError'; }
}
