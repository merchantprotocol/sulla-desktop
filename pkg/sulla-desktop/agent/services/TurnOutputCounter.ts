// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/**
 * Counts real output a graph turn produced, stored on the thread's metadata.
 *
 * Unlike `lastActivityMs` / `lastAgentActivityAt` (stamped on every model
 * call, empty streaming sentinel and "Preparing your turn…" heartbeat), this
 * only advances on evidence the model actually did something: a non-blank
 * streamed token, a Sulla tool batch executed, or a provider-managed (Claude
 * Code / Codex CLI, local or container) tool call or file patch.
 */
export class TurnOutputCounter {
  static readonly KEY = 'turnOutputCount';

  constructor(private readonly metadata: Record<string, any> | undefined) {}

  /** Record output when the token carries visible content. */
  recordToken(token: unknown): void {
    if (typeof token === 'string' && token.trim()) this.record();
  }

  record(): void {
    if (!this.metadata) return;
    this.metadata[TurnOutputCounter.KEY] = this.read() + 1;
  }

  read(): number {
    const value = this.metadata?.[TurnOutputCounter.KEY];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
  }
}
