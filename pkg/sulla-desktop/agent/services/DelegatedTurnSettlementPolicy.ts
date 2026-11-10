// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export type DelegatedTurnSettlement = 'terminal' | 'child_park' | 'wait_park' | 'remind' | 'auto_park' | 'fail';
export type TurnEndClassification = 'completed' | 'not_done' | 'blocked';
/** Classifies only worker-authored final text; tool execution is settled before this is called. */
export class TurnEndClassifier {
  classify(text: string): TurnEndClassification {
    if (/<AGENT_DONE>/.test(text)) return 'completed';
    if (/<AGENT_BLOCKED>|\[BLOCKED\]/.test(text)) return 'blocked';
    if (/<AGENT_CONTINUE>|\bPARKED\b/.test(text)) return 'not_done';
    return 'not_done';
  }
}
export class DelegatedTurnSettlementPolicy {
  constructor(private readonly classifier = new TurnEndClassifier()) {}
  decide(input: { returned: boolean; openChildren: number; pendingWait: boolean; reminderSent: boolean; autoParkCount?: number; finalText?: string; schemaContract?: boolean }): DelegatedTurnSettlement {
    if (input.returned) return 'terminal';
    if (input.openChildren > 0) return 'child_park';
    if (input.pendingWait) return 'wait_park';
    const classification = this.classifier.classify(input.finalText ?? '');
    if (classification === 'completed' || classification === 'blocked') return 'terminal';
    const hasNotDoneMarker = /<AGENT_CONTINUE>|\bPARKED\b/.test(input.finalText ?? '');
    if (input.schemaContract && !hasNotDoneMarker) return input.reminderSent ? 'fail' : 'remind';
    // A manager's ordinary final answer is terminal once its children and waits
    // have settled. Auto-parking is for an explicit not-done marker or a turn
    // that produced no answer at all, not any arbitrary unmarked prose.
    if (!hasNotDoneMarker && Boolean(input.finalText?.trim())) return 'terminal';
    if (!input.reminderSent) return 'remind';
    return (input.autoParkCount ?? 0) >= 3 ? 'fail' : 'auto_park';
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
