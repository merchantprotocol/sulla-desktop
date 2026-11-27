// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type TurnTimingSurface = 'chat' | 'delegated' | 'heartbeat' | 'other';
export type TurnTimingProvider = 'codex' | 'claude' | 'api' | 'other';
export type TurnTimingOutcome = 'ok' | 'error' | 'aborted';
export type TurnTimingToolSource = 'native' | 'codex_cli' | 'claude_cli' | 'mcp';

export interface TurnTimingClock {
  epochNow(): number;
  now(): number;
}

/** Production clock: wall time for the record anchor, monotonic time for spans. */
export class SystemTurnTimingClock implements TurnTimingClock {
  epochNow(): number { return Date.now(); }
  now(): number { return performance.now(); }
}

export interface TurnTimingLog {
  log(message: string): void;
}

/** Narrow structural seam shared with the provider bridge's request handler. */
export interface TurnTimingProviderRequestSink {
  readonly runId?: string;
  beginProviderRequest(bridgeRequestId: string): void;
  markFirstByte(bridgeRequestId: string): void;
  markFirstText(bridgeRequestId: string): void;
  endProviderRequest(bridgeRequestId: string, status: number | null, bodyBytes: number | null): void;
}

export interface TurnTimingOptions {
  clock: TurnTimingClock;
  perfLog: TurnTimingLog;
  runId: string;
  surface: TurnTimingSurface;
  provider: TurnTimingProvider;
  model: string | null;
  threadId: string;
  jobId?: string | null;
  taskIndex?: number | null;
  startedAtMs?: number;
  queueWaitMs?: number | null;
}

interface ProviderRequestTiming {
  bridgeRequestId: string;
  startMs: number;
  firstByteMs: number | null;
  firstTextMs: number | null;
  endMs: number | null;
  status: number | null;
  bodyBytes: number | null;
}

interface ToolStepTiming {
  name: string;
  source: TurnTimingToolSource;
  startMs: number;
  endMs: number | null;
  durationMs: number | null;
  ok: boolean | null;
}

/** Labels a tool with its executable/tool name only; never includes args or paths. */
export class SafeToolLabel {
  static from(value: unknown): string {
    if (typeof value !== 'string') return 'tool';
    const tokens = value.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return 'tool';

    const program = this.basename(tokens[0]);
    if (program.toLowerCase() === 'sulla') {
      const route = this.stripQuotes(tokens[1] || '');
      return /^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(route) ? `sulla ${ route }` : 'sulla';
    }
    return this.safeName(program);
  }

  private static basename(value: string): string {
    return this.stripQuotes(value).split(/[\\/]/).pop() || '';
  }

  private static stripQuotes(value: string): string {
    return value.replace(/^["'`]+|["'`]+$/g, '');
  }

  private static safeName(value: string): string {
    const name = value.replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 80);
    return name && name !== '.' && name !== '..' ? name : 'tool';
  }
}

/**
 * One isolated accumulator per accepted agent turn. Only identifiers, enums,
 * safe tool labels, and numeric timing data are ever written to perf.log.
 */
export class TurnTiming implements TurnTimingProviderRequestSink {
  private readonly startedAtMs: number;
  private readonly startedAtClockMs: number;
  private queueWaitMs: number | null;
  private provider: TurnTimingProvider;
  private model: string | null;
  private preModelMs: number | null = null;
  private preModelEndElapsedMs: number | null = null;
  private firstVisibleTextMs: number | null = null;
  private reasoningMs: number | null = null;
  private readonly providerRequests: ProviderRequestTiming[] = [];
  private readonly providerRequestsById = new Map<string, ProviderRequestTiming>();
  private readonly toolSteps: ToolStepTiming[] = [];
  private readonly toolStepsById = new Map<string, ToolStepTiming>();
  private truncatedSteps = 0;
  private finished = false;

  constructor(private readonly options: TurnTimingOptions) {
    this.startedAtMs = options.startedAtMs ?? options.clock.epochNow();
    this.startedAtClockMs = options.clock.now();
    this.queueWaitMs = this.durationOrNull(options.queueWaitMs);
    this.provider = options.provider;
    this.model = options.model;
  }

  get runId(): string { return this.options.runId; }

  /** Set once the turn reaches its first provider request. */
  markPreModelEnd(): void {
    if (this.preModelEndElapsedMs !== null) return;
    this.preModelEndElapsedMs = this.elapsedMs();
    this.preModelMs = Math.max(0, this.preModelEndElapsedMs - (this.queueWaitMs ?? 0));
  }

  /** Admission/dispatch wait measured outside the accumulator. */
  setQueueWaitMs(durationMs: number | null): void {
    if (this.finished) return;
    this.queueWaitMs = this.durationOrNull(durationMs);
    if (this.preModelEndElapsedMs !== null) {
      this.preModelMs = Math.max(0, this.preModelEndElapsedMs - (this.queueWaitMs ?? 0));
    }
  }

  setProviderModel(provider: TurnTimingProvider, model: string | null): void {
    if (this.finished) return;
    this.provider = provider;
    this.model = typeof model === 'string' && model.trim() ? model.trim() : null;
  }

  beginProviderRequest(bridgeRequestId: string): void {
    if (this.finished || !bridgeRequestId || this.providerRequestsById.has(bridgeRequestId)) return;
    this.markPreModelEnd();
    if (this.providerRequests.length >= 500) return;
    const request: ProviderRequestTiming = {
      bridgeRequestId,
      startMs: this.elapsedMs(),
      firstByteMs: null,
      firstTextMs: null,
      endMs: null,
      status: null,
      bodyBytes: null,
    };
    this.providerRequests.push(request);
    this.providerRequestsById.set(bridgeRequestId, request);
  }

  markFirstByte(bridgeRequestId: string): void {
    if (this.finished) return;
    const request = this.providerRequestsById.get(bridgeRequestId);
    if (request && request.firstByteMs === null) request.firstByteMs = this.elapsedMs();
  }

  markFirstText(bridgeRequestId: string): void {
    if (this.finished) return;
    const request = this.providerRequestsById.get(bridgeRequestId);
    if (request && request.firstTextMs === null) request.firstTextMs = this.elapsedMs();
  }

  endProviderRequest(bridgeRequestId: string, status: number | null, bodyBytes: number | null): void {
    if (this.finished) return;
    const request = this.providerRequestsById.get(bridgeRequestId);
    if (!request || request.endMs !== null) return;
    request.endMs = this.elapsedMs();
    request.status = Number.isFinite(status) ? status : null;
    request.bodyBytes = this.durationOrNull(bodyBytes);
  }

  beginToolStep(stepId: string, safeLabel: string, source: TurnTimingToolSource): void {
    if (this.finished || !stepId || this.toolStepsById.has(stepId)) return;
    if (this.toolSteps.length >= 500) {
      this.truncatedSteps++;
      return;
    }
    const step: ToolStepTiming = {
      name: SafeToolLabel.from(safeLabel),
      source,
      startMs: this.elapsedMs(),
      endMs: null,
      durationMs: null,
      ok: null,
    };
    this.toolSteps.push(step);
    this.toolStepsById.set(stepId, step);
  }

  endToolStep(stepId: string, ok: boolean): void {
    if (this.finished) return;
    const step = this.toolStepsById.get(stepId);
    if (!step || step.endMs !== null) return;
    step.endMs = this.elapsedMs();
    step.durationMs = Math.max(0, step.endMs - step.startMs);
    step.ok = ok;
  }

  addReasoning(durationMs: number): void {
    if (!this.finished && Number.isFinite(durationMs) && durationMs >= 0) this.reasoningMs = (this.reasoningMs ?? 0) + durationMs;
  }

  markFirstVisibleText(): void {
    if (this.finished) return;
    if (this.firstVisibleTextMs === null) this.firstVisibleTextMs = this.elapsedMs();
  }

  /** Flush one privacy-safe JSON record; repeated settlement is a no-op. */
  finish(outcome: TurnTimingOutcome): void {
    if (this.finished) return;
    const endMs = this.elapsedMs();
    for (const request of this.providerRequests) {
      if (request.endMs === null) request.endMs = endMs;
    }
    for (const step of this.toolSteps) {
      if (step.endMs !== null) continue;
      step.endMs = endMs;
      step.durationMs = Math.max(0, endMs - step.startMs);
    }
    this.finished = true;
    const record: Record<string, unknown> = {
      schemaVersion: 1,
      runId: this.options.runId,
      surface: this.options.surface,
      provider: this.provider,
      model: this.model,
      outcome,
      threadId: this.options.threadId,
      jobId: this.options.jobId ?? null,
      taskIndex: this.options.taskIndex ?? null,
      startedAtMs: this.startedAtMs,
      queueWaitMs: this.queueWaitMs,
      preModelMs: this.preModelMs,
      firstVisibleTextMs: this.firstVisibleTextMs,
      reasoningMs: this.reasoningMs,
      totalMs: endMs,
      providerRequests: this.providerRequests,
      toolSteps: this.toolSteps,
    };
    if (this.truncatedSteps > 0) record.truncatedSteps = this.truncatedSteps;
    this.options.perfLog.log(`[TurnTiming] ${ JSON.stringify(record) }`);
  }

  private elapsedMs(): number {
    return Math.max(0, this.options.clock.now() - this.startedAtClockMs);
  }

  private durationOrNull(value: number | null | undefined): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : null;
  }
}
