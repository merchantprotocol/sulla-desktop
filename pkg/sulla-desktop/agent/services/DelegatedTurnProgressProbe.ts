// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { TurnOutputCounter } from './TurnOutputCounter';

/**
 * Detects whether one delegated graph turn produced real output.
 *
 * The {@link TurnOutputCounter} is the ONLY signal. It advances on a non-blank
 * streamed token, an assistant reply appended by BaseNode.appendResponse, a
 * Sulla tool batch (ToolExecutor) and a provider-managed (Claude Code / Codex
 * CLI) tool call or file patch.
 *
 * Inspecting `state.messages` is unreliable in both directions: counting
 * assistant messages misses trimmed histories and CLI-run tools, and
 * comparing message object identity counts rewritten history as new output
 * (SubconsciousMiddleware.applyPendingBackground splices JSON-cloned snapshot
 * messages in at the start of every turn), which would acknowledge child
 * completions the manager never read. Activity timestamps are no signal
 * either: BaseNode stamps them on every model call and heartbeat.
 */
export class DelegatedTurnProgressProbe {
  private readonly priorOutputCount: number;

  constructor(private readonly state: any) {
    this.priorOutputCount = this.outputCount();
  }

  madeProgress(): boolean {
    return this.outputCount() !== this.priorOutputCount;
  }

  private outputCount(): number {
    return new TurnOutputCounter(this.state?.metadata).read();
  }
}
