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
import { SuspendAwareClock } from './SuspendAwareClock';

export const LONG_TOOL_CEILING_MS = 2 * 60 * 60_000;

export interface RunToolInFlight { name: string; startedAt: number }

const HUMAN_WAIT_TOOL = /ask_user|approv|permission|question/i;

/**
 * Tools that wait on the human (approvals, ask_user_question). Waiting on the
 * human is alive, however long it takes; approval expiry owns these, so they
 * are never reported as a hung tool or a dead agent.
 */
export function isHumanWaitTool(name: string | undefined): boolean {
  return HUMAN_WAIT_TOOL.test(name ?? '');
}

/** A tool still running keeps the run alive: a human wait always, anything else up to the ceiling. */
export function toolHoldsRunAlive(tool: RunToolInFlight | undefined, now: number, ceilingMs: number = LONG_TOOL_CEILING_MS): boolean {
  return tool !== undefined && (isHumanWaitTool(tool.name) || now - tool.startedAt < ceilingMs);
}

/** The tool a run is blocked on: a human wait first, then the oldest call. */
export function blockingTool<T extends RunToolInFlight>(tools: Iterable<T>): T | undefined {
  let oldest: T | undefined;
  for (const tool of tools) {
    if (isHumanWaitTool(tool.name)) return tool;
    if (!oldest || tool.startedAt < oldest.startedAt) oldest = tool;
  }
  return oldest;
}

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
  private readonly clock: () => number;
  private readonly suspendAwareClock?: SuspendAwareClock;
  private readonly tools = new Map<string, RunToolInFlight>();

  constructor(
    private readonly silenceLimitMs: number,
    private readonly toolCeilingMs: number = LONG_TOOL_CEILING_MS,
    clock?: () => number,
    private readonly externalActivityAt: () => number = () => 0,
    suspendAwareClock?: SuspendAwareClock,
  ) {
    this.suspendAwareClock = clock ? undefined : (suspendAwareClock ?? new SuspendAwareClock());
    this.clock = clock ?? (() => this.suspendAwareClock!.now());
    this.lastActivityAt = this.clock();
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

  /** The tool call the run is blocked on (a human wait first, then the oldest), if any. */
  oldestTool(): RunToolInFlight | undefined {
    return blockingTool(this.tools.values());
  }

  /** Last time anything in the loop happened, including relayed provider output. */
  lastSeenAt(): number {
    const external = this.externalActivityAt();
    const adjustedExternal = external && this.suspendAwareClock ? this.suspendAwareClock.toLogicalTime(external) : external;
    return Math.max(this.lastActivityAt, adjustedExternal || 0);
  }

  describeHungTool(tool: RunToolInFlight | undefined = this.oldestTool()): string {
    return tool ? describeHungTool(tool, this.clock()) : 'no tool is unresolved';
  }

  verdict(): RunLivenessVerdict {
    const now = this.clock();
    const silentMs = Math.max(0, now - this.lastSeenAt());
    const tool = this.oldestTool();
    // A tool still running is the agent working, however quiet it is, up to the
    // ceiling; a wait on the human (approval, question) has no ceiling here.
    if (toolHoldsRunAlive(tool, now, this.toolCeilingMs)) return { kind: 'alive' };
    if (silentMs < this.silenceLimitMs) return { kind: 'alive' };
    if (tool) return { kind: 'tool_hung', silentMs, tool, runningMs: now - tool.startedAt };
    return { kind: 'silent', silentMs };
  }
}
