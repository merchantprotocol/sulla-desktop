// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type ToolOperationType = 'read' | 'create' | 'update' | 'delete' | 'execute';

export interface ToolDeadlineDetails {
  tool: string;
  deadlineMs: number;
  elapsedMs: number;
  sideEffectUnknown?: true;
  hint: string;
}

/** Central deadline defaults and timeout guidance for manifest-backed tool calls. */
export class ToolDeadlinePolicy {
  private readonly overrides = new Map<string, number>([
    ['git_push', 120_000], ['git_fetch', 120_000], ['create_pr', 120_000],
    ['merge_pr', 120_000], ['ci_logs', 120_000],
  ]);

  deadlineMs(tool: string, operationTypes: readonly string[] = []): number {
    const override = this.overrides.get(tool);
    if (override !== undefined) return override;
    return operationTypes.length > 0 && operationTypes.every(type => type === 'read') ? 15_000 : 120_000;
  }

  timeoutDetails(tool: string, deadlineMs: number, elapsedMs: number, operationTypes: readonly string[] = []): ToolDeadlineDetails {
    const sideEffectUnknown = operationTypes.some(type => ['create', 'update', 'delete', 'execute'].includes(type));
    return {
      tool,
      deadlineMs,
      elapsedMs,
      ...(sideEffectUnknown ? { sideEffectUnknown: true as const } : {}),
      hint: sideEffectUnknown ? `check state before retrying, e.g. github/list_prs for ${ tool }` : 'safe to retry once',
    };
  }
}
