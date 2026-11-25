// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { StreamCallbacks } from './BaseLanguageModel';

export interface ClaudeToolExecutionTotal {
  count: number;
  ms:    number;
}

/** Correlates Claude tool_use/tool_result records and emits complete tool events. */
export class ClaudeToolEventTracker {
  private readonly starts = new Map<string, { name: string; input?: unknown; startedAt: number }>();
  readonly totals = new Map<string, ClaudeToolExecutionTotal>();

  constructor(
    private readonly callbacks: Pick<StreamCallbacks, 'onToolStarted' | 'onToolEvent'>,
    private readonly now: () => number = Date.now,
    private readonly reportTiming: (toolName: string, elapsedMs: number, resultChars: number) => void = () => {},
  ) {}

  /** Tool calls started but not yet answered with a tool_result. */
  get pendingCount(): number {
    return this.starts.size;
  }

  noteStart(toolUseId?: string, toolName?: string, input?: unknown): void {
    if (!toolUseId || this.starts.has(toolUseId)) return;
    const name = toolName ?? 'tool';
    this.starts.set(toolUseId, { name, input, startedAt: this.now() });
    this.callbacks.onToolStarted?.({ toolUseId, toolName: name, input });
  }

  noteResult(toolUseId?: string, result: unknown = '', isError = false): void {
    if (!toolUseId) return;
    const started = this.starts.get(toolUseId);
    if (!started) return;
    this.starts.delete(toolUseId);
    const elapsedMs = this.now() - started.startedAt;
    const total = this.totals.get(started.name) ?? { count: 0, ms: 0 };
    total.count += 1;
    total.ms += elapsedMs;
    this.totals.set(started.name, total);
    const resultText = this.toText(result);
    const resultChars = typeof result === 'string' ? result.length : resultText.length;
    this.reportTiming(started.name, elapsedMs, resultChars);
    try {
      this.callbacks.onToolEvent?.({
        toolUseId, toolName: started.name, input: started.input, result: isError ? undefined : result, resultChars,
        error: isError ? resultText : undefined, isError,
      });
    } catch { /* provider callbacks are best-effort */ }
  }

  private toText(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value);
  }
}
