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
  private readonly writerDeadlineMs = 120_000;
  private readonly readDeadlineMs = 15_000;
  private readonly requestDefaultMs = 30_000;
  private readonly overrides = new Map<string, number>([
    ['git_push', 120_000], ['git_fetch', 120_000], ['create_pr', 120_000],
    // Large private repository packfiles can take several minutes over the
    // credential broker; clone has its own matching command timeout.
    ['git_clone', 1_800_000],
    ['merge_pr', 120_000], ['ci_logs', 120_000],
    // Long-polls the agent mailbox for up to 300 s (AgentMailClient.MAX_WAIT_SECONDS).
    ['mail_wait_for_code', 305_000],
  ]);

  /** Longest deadline this policy ever hands out; Desktop must not clamp requests below it. */
  get maxDeadlineMs(): number {
    return Math.max(this.writerDeadlineMs, ...this.overrides.values());
  }

  deadlineMs(tool: string, operationTypes: readonly string[] = []): number {
    const override = this.overrides.get(tool);
    if (override !== undefined) return override;
    return operationTypes.length > 0 && operationTypes.every(type => type === 'read') ? this.readDeadlineMs : this.writerDeadlineMs;
  }

  /** Bounds a deadline a relay or executor asks for: default when absent or not a number, clamped to [1, maxDeadlineMs]. */
  requestedDeadlineMs(raw: unknown): number {
    const requested = raw === undefined || raw === null ? this.requestDefaultMs : Number(raw);
    const finite = Number.isFinite(requested) ? requested : this.requestDefaultMs;
    return Math.max(1, Math.min(finite, this.maxDeadlineMs));
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
