// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { reactive, readonly } from 'vue';

import type { AgentRowState } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { RunState } from '../../models/RunState';

export type TypingIndicatorKind = 'hidden' | 'running' | 'streaming' | 'tool' | 'parked' | 'stalled' | 'error' | 'stopped';

export interface TypingIndicatorAgent {
  readonly key: string;
  readonly initials: string;
  readonly name: string;
  readonly state: AgentRowState;
  /** Last source event included in the agent projection, used to reset stall timing. */
  readonly activityKey: string;
}

export interface TypingIndicatorInput {
  readonly runState: RunState;
  readonly agents: readonly TypingIndicatorAgent[];
  readonly assistantStreaming: boolean;
  /** A terminal assistant reply for the latest user turn is already in the transcript. */
  readonly finalReply: boolean;
  readonly retryAvailable: boolean;
  /** Best event time from the root controller, transcript, or scoped agent projection. */
  readonly activityAt: number;
  /** Changes only when a real run/token/agent event arrives. */
  readonly activityKey: string;
}

export interface TypingIndicatorSnapshot {
  kind: TypingIndicatorKind;
  /** Whether a tail row should render; streaming text already occupies that position. */
  shouldRender: boolean;
  /** True only for the three-dot/tool bubble; parked and stopped/error are text rows. */
  bubbleVisible: boolean;
  toolName: string | null;
  agents: readonly TypingIndicatorAgent[];
  retryAvailable: boolean;
  errorMessage: string | null;
}

export interface TypingIndicatorClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const browserTypingIndicatorClock: TypingIndicatorClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Derives the approved thread-tail indicator from live controller and scoped-agent state. */
export class TypingIndicatorState {
  /** The approved typing-indicator mockup marks a no-event loop stalled at 60 seconds. */
  static readonly stalledAfterMs = 60_000;

  static timestamp(value: string | null | undefined): number {
    if (!value) return 0;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private readonly mutable: TypingIndicatorSnapshot = reactive({
    kind: 'hidden', shouldRender: false, bubbleVisible: false, toolName: null,
    agents: [], retryAvailable: false, errorMessage: null,
  }) as TypingIndicatorSnapshot;
  readonly state = readonly(this.mutable) as Readonly<TypingIndicatorSnapshot>;

  private input: TypingIndicatorInput | null = null;
  private activityKey: string | null = null;
  private lastActivityAt = 0;
  private stallTimer: unknown = null;

  constructor(private readonly clock: TypingIndicatorClock = browserTypingIndicatorClock) {}

  update(input: TypingIndicatorInput): void {
    if (input.activityKey !== this.activityKey) {
      const now = this.clock.now();
      const sourceAt = Number.isFinite(input.activityAt) && input.activityAt > 0 ? input.activityAt : now;
      this.lastActivityAt = this.activityKey === null ? sourceAt : Math.max(sourceAt, now);
      this.activityKey = input.activityKey;
    }
    this.input = input;
    this.recompute();
  }

  dispose(): void {
    this.clearStallTimer();
    this.input = null;
  }

  private recompute(): void {
    this.clearStallTimer();
    const input = this.input;
    if (!input) { this.apply('hidden'); return }

    // A completed assistant turn wins even if a terminal controller event and
    // the final message land in the same renderer update.
    if (input.finalReply) { this.apply('hidden'); return }

    const run = input.runState;
    if (run.phase === 'error') {
      this.apply('error', { retryAvailable: input.retryAvailable, errorMessage: run.message });
      return;
    }
    if (run.phase === 'paused') {
      if (run.reason === 'user') { this.apply('stopped'); return }
      this.apply('error', {
        retryAvailable: input.retryAvailable,
        errorMessage: run.reason === 'limit' ? 'The run reached its step limit.' : 'The run stopped unexpectedly.',
      });
      return;
    }

    const workingAgents = input.agents.filter(agent => agent.state === 'working');
    if (run.phase === 'idle') {
      if (workingAgents.length) this.apply('parked', { agents: workingAgents });
      else this.apply('hidden');
      return;
    }
    if (run.phase === 'awaiting_approval') { this.apply('hidden'); return }

    const stalled = this.clock.now() - this.lastActivityAt >= TypingIndicatorState.stalledAfterMs;
    if (stalled) {
      this.apply('stalled', { toolName: run.phase === 'tool' ? this.toolName(run.tool) : null });
      return;
    }
    this.scheduleStallCheck();

    if (run.phase === 'tool') {
      this.apply('tool', { toolName: this.toolName(run.tool) });
      return;
    }
    if (run.phase === 'streaming' || input.assistantStreaming) { this.apply('streaming'); return }
    this.apply('running');
  }

  private scheduleStallCheck(): void {
    const input = this.input;
    if (!input || !this.isStallable(input.runState)) return;
    const remaining = this.lastActivityAt + TypingIndicatorState.stalledAfterMs - this.clock.now();
    if (remaining <= 0) return;
    this.stallTimer = this.clock.setTimeout(() => {
      this.stallTimer = null;
      this.recompute();
    }, remaining);
  }

  private clearStallTimer(): void {
    if (this.stallTimer === null) return;
    this.clock.clearTimeout(this.stallTimer);
    this.stallTimer = null;
  }

  private isStallable(run: RunState): boolean {
    return run.phase === 'thinking' || run.phase === 'tool' || run.phase === 'streaming';
  }

  private toolName(tool: string): string {
    return tool.trim() || 'Tool';
  }

  private apply(kind: TypingIndicatorKind, options: Partial<Pick<TypingIndicatorSnapshot,
    'agents' | 'toolName' | 'retryAvailable' | 'errorMessage'>> = {}): void {
    const shouldRender = kind !== 'hidden' && kind !== 'streaming';
    this.mutable.kind = kind;
    this.mutable.shouldRender = shouldRender;
    this.mutable.bubbleVisible = kind === 'running' || kind === 'tool' || kind === 'stalled';
    this.mutable.toolName = options.toolName ?? null;
    this.mutable.agents = options.agents ?? [];
    this.mutable.retryAvailable = options.retryAvailable ?? false;
    this.mutable.errorMessage = options.errorMessage ?? null;
  }
}
