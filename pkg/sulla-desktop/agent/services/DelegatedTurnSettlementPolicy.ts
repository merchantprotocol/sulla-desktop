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

  failureCause(finalState: any): string {
    const messages = Array.isArray(finalState?.messages) ? [...finalState.messages].reverse() : [];
    const assistant = messages.find((message: any) => message?.role === 'assistant');
    if (!assistant) return '(no assistant output was recorded)';
    const content = typeof assistant.content === 'string' ? assistant.content.trim() : JSON.stringify(assistant.content ?? '');
    const toolCalls = assistant.tool_calls ?? assistant.toolCalls;
    return toolCalls ? `${ content || '(empty assistant text)' }\nTool call: ${ JSON.stringify(toolCalls) }` : (content || '(empty assistant text)');
  }
}
export class MissingContractAfterReminderError extends Error {
  readonly code = 'missing_contract_after_reminder';
  constructor(causeText: string) { super(`missing_contract_after_reminder: delegated worker ended twice without returning its contract. Last assistant output/tool call:\n${ causeText }`); this.name = 'MissingContractAfterReminderError'; }
}
