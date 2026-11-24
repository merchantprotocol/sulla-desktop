// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Jonathon's rule (2026-11-24): an agent is stalled only when its WHOLE loop
 * is idle. Model stream output (including reasoning), a tool call starting, a
 * tool call still running, a tool result, a check-in or a chat message all
 * count as alive. Chat silence alone never does.
 *
 * A tool that is still running holds the run alive up to this ceiling. Past
 * it the tool is reported as hung ("tool still running for Xm: <name>"), never
 * as a dead agent. Two hours matches the old approval-wait allowance and is
 * far beyond any sane build, test suite or command.
 */
export const LONG_TOOL_CEILING_MS = 2 * 60 * 60_000;

export interface RunToolInFlight { name: string; startedAt: number }

export type RunLivenessVerdict =
  | { kind: 'alive' }
  | { kind: 'silent'; silentMs: number }
  | { kind: 'tool_hung'; silentMs: number; tool: RunToolInFlight; runningMs: number };

/** Human-readable label for a tool that outlived the ceiling. */
export function describeHungTool(tool: RunToolInFlight, now: number = Date.now()): string {
  return `tool still running for ${ Math.max(0, Math.floor((now - tool.startedAt) / 60_000)) }m: ${ tool.name || 'a tool' }`;
}

/**
 * Per-run liveness clock for one CLI child (Codex, Claude Code, other CLIs).
 * Every observed event touches it; tool calls are tracked until their result
 * arrives. `externalActivityAt` lets a run count activity it does not see on
 * its own stdout, such as provider stream chunks relayed by the bridge.
 */
export class RunLivenessClock {
  private lastActivityAt: number;
  private readonly tools = new Map<string, RunToolInFlight>();

  constructor(
    private readonly silenceLimitMs: number,
    private readonly toolCeilingMs: number = LONG_TOOL_CEILING_MS,
    private readonly clock: () => number = Date.now,
    private readonly externalActivityAt: () => number = () => 0,
  ) {
    this.lastActivityAt = clock();
  }

  /** Restart the silence window (process spawned). */
  start(): void { this.lastActivityAt = this.clock() }

  /** Any stream byte, event, steer or callback from the run. */
  touch(): void { this.lastActivityAt = this.clock() }

  /** Returns true when this call id was not already running. */
  toolStarted(id: string, name: string): boolean {
    this.touch();
    if (!id || this.tools.has(id)) return false;
    this.tools.set(id, { name: name || 'a tool', startedAt: this.clock() });
    return true;
  }

  toolFinished(id: string): void {
    this.touch();
    if (id) this.tools.delete(id);
  }

  get toolsInFlight(): number { return this.tools.size }

  /** The oldest tool call still running, if any. */
  oldestTool(): RunToolInFlight | undefined {
    let oldest: RunToolInFlight | undefined;
    for (const tool of this.tools.values()) if (!oldest || tool.startedAt < oldest.startedAt) oldest = tool;
    return oldest;
  }

  /** Last time anything in the loop happened, including relayed provider output. */
  lastSeenAt(): number {
    return Math.max(this.lastActivityAt, this.externalActivityAt() || 0);
  }

  verdict(): RunLivenessVerdict {
    const now = this.clock();
    const silentMs = Math.max(0, now - this.lastSeenAt());
    const tool = this.oldestTool();
    // A tool still running is the agent working, however quiet it is, up to the ceiling.
    if (tool && now - tool.startedAt < this.toolCeilingMs) return { kind: 'alive' };
    if (silentMs < this.silenceLimitMs) return { kind: 'alive' };
    if (tool) return { kind: 'tool_hung', silentMs, tool, runningMs: now - tool.startedAt };
    return { kind: 'silent', silentMs };
  }
}
