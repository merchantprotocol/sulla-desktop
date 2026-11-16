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
  retryable: true;
  hint: string;
}

/** What a caller knows about one tool call beyond its name and operation types. */
export interface ToolDeadlineHints {
  /** Manifest category (e.g. `github`). Network-bound categories get the network-read deadline. */
  category?:          string;
  /** Explicit `deadlineMs` declared on the tool manifest; replaces the name/class default (args may still extend it). */
  manifestDeadlineMs?: number;
  /** Call arguments; a caller-supplied `timeout`/`timeoutMs` extends the deadline so the tool's own timer fires first. */
  args?:              unknown;
}

/** Central deadline defaults and timeout guidance for manifest-backed tool calls. */
export class ToolDeadlinePolicy {
  private readonly writerDeadlineMs = 120_000;
  /** Local reads (catalog, memory, files) must fail fast. */
  private readonly readDeadlineMs = 15_000;
  /**
   * Reads that leave the machine: every GitHub/Slack/Drive read is a vault
   * broker hop plus a third-party API round trip, and a 100-item PR page can
   * take well over 15 s on a busy repository.
   */
  private readonly networkReadDeadlineMs = 60_000;
  private readonly networkCategories = new Set(['github', 'slack', 'discord', 'google_drive', 'gdrive', 'mail']);
  private readonly requestDefaultMs = 30_000;
  /** Grace added to a caller-supplied timeout so the tool reports its own timeout before the transport cuts it off. */
  private readonly argTimeoutGraceMs = 5_000;
  /** Ceiling for argument-derived deadlines; explicit manifest overrides may go higher. */
  private readonly maxArgDeadlineMs = 1_800_000;
  /** Keyed by bare tool name; registered names carry a `<category>_` prefix (`github_ci_logs`). */
  private readonly overrides = new Map<string, number>([
    ['git_push', 120_000], ['git_fetch', 120_000], ['create_pr', 120_000],
    // Large private repository packfiles can take several minutes over the
    // credential broker; clone has its own matching command timeout.
    ['git_clone', 1_800_000],
    ['merge_pr', 120_000], ['ci_logs', 120_000],
    // Long-polls the agent mailbox for up to 300 s (AgentMailClient.MAX_WAIT_SECONDS).
    ['mail_wait_for_code', 305_000],
  ]);

  /** Longest deadline this policy ever hands out; Desktop and the relay must not clamp requests below it. */
  get maxDeadlineMs(): number {
    return Math.max(this.writerDeadlineMs, this.maxArgDeadlineMs, ...this.overrides.values());
  }

  deadlineMs(tool: string, operationTypes: readonly string[] = [], hints: ToolDeadlineHints = {}): number {
    const declared = this.positive(hints.manifestDeadlineMs);
    const base = declared !== undefined
      ? Math.min(declared, this.maxDeadlineMs)
      : this.overrideFor(tool, hints.category) ?? this.classDeadlineMs(operationTypes, hints.category);
    const argTimeout = this.argTimeoutMs(hints.args);
    if (argTimeout === undefined) return base;
    return Math.max(base, Math.min(argTimeout + this.argTimeoutGraceMs, this.maxArgDeadlineMs));
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
      retryable: true,
      hint: sideEffectUnknown
        ? `timed out after ${ elapsedMs } ms; the call may still have completed, check state before retrying, e.g. github/list_prs for ${ tool }`
        : `timed out after ${ elapsedMs } ms; read-only, safe to retry once`,
    };
  }

  private overrideFor(tool: string, category?: string): number | undefined {
    const exact = this.overrides.get(tool);
    if (exact !== undefined) return exact;
    const prefixes = [category, 'github'].filter((value): value is string => !!value);
    for (const prefix of prefixes) {
      if (tool.startsWith(`${ prefix }_`)) {
        const bare = this.overrides.get(tool.slice(prefix.length + 1));
        if (bare !== undefined) return bare;
      }
    }
    return undefined;
  }

  private classDeadlineMs(operationTypes: readonly string[], category?: string): number {
    const readOnly = operationTypes.length > 0 && operationTypes.every(type => type === 'read');
    if (!readOnly) return this.writerDeadlineMs;
    return category && this.networkCategories.has(category) ? this.networkReadDeadlineMs : this.readDeadlineMs;
  }

  private argTimeoutMs(args: unknown): number | undefined {
    if (!args || typeof args !== 'object') return undefined;
    const record = args as Record<string, unknown>;
    return this.positive(record.timeoutMs) ?? this.positive(record.timeout);
  }

  private positive(value: unknown): number | undefined {
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    return typeof number === 'number' && Number.isFinite(number) && number > 0 ? number : undefined;
  }
}
