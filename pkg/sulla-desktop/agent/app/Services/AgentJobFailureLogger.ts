// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { createHash } from 'crypto';

import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

/** Receives every committed job write so task failures can be reported at one choke point. */
export interface AgentJobFailureObserver {
  observe(previous: AgentJob, next: AgentJob): void;
}

/** The background-log writer (Logging.background in production). */
export interface AgentJobFailureLogSink {
  error(message: string): void;
}

export interface WakeObservation {
  jobId: string;
  taskIndex: number;
  wakeId: unknown;
  source: unknown;
  attempt: number;
  cacheHit?:          boolean;
  graphCache: 'live_runner' | 'registry' | 'miss';
  providerDispatched: boolean;
  liveChildCount: number;
  inputTokens?: number;
  outputTokens?: number;
}

export type AgentJobFailureReason = 'dead_run' | 'lost' | 'recovery_exhausted' | 'empty_wake' | 'unprocessed_result' | 'contract_missing' | 'deadline' | 'provider_transport' | 'stopped' | 'error';

export interface AgentJobFailureRecord {
  jobId: string;
  taskIndex: number;
  agentId: string;
  label: string;
  parentJobId: string | null;
  threadId: string | null;
  parentThreadId: string | null;
  runLocation: string | null;
  provider: string | null;
  model: string | null;
  /** The task's own status; a task stranded live under a failed job is logged as `running`/`queued`/... with jobStatus `failed`. */
  status: AgentJobTask['status'];
  jobStatus: AgentJob['status'];
  reason: AgentJobFailureReason;
  stoppedBy: string | null;
  error: string;
  stack?: string;
  elapsedMs: number | null;
}

/**
 * Writes exactly one `[agent-job] task failed` line to background.log when a
 * task newly enters `error`, or `stopped` without a human/agent principal
 * (system kills such as the dead-run watcher), or when the job itself newly
 * becomes `failed` while tasks are still live (restart-recovery exhaustion
 * fails the row without touching its tasks). It compares the row before and
 * after each committed write, so repeated rewrites never log twice and
 * completed tasks never log.
 */
export class AgentJobFailureLogger implements AgentJobFailureObserver {
  static readonly TAG = '[agent-job] task failed';
  static readonly MAX_ERROR_CHARS = 2_048;
  static readonly MAX_STACK_CHARS = 4_096;
  private static readonly SECRET_PATTERNS: readonly [RegExp, string][] = [
    [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
    [/\bsk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]'],
    [/\bgithub_pat_[A-Za-z0-9_]{8,}/g, '[REDACTED]'],
    [/\bgh[pousr]_[A-Za-z0-9]{8,}/g, '[REDACTED]'],
    [/\bxox[abprse]-[A-Za-z0-9-]{8,}/g, '[REDACTED]'],
  ];

  constructor(private readonly sink: AgentJobFailureLogSink) {}

  /** Opaque IDs may be caller-provided. Only a correlation hash and known source categories leave the runner. */
  wake(facts: WakeObservation): void {
    const source = AgentJobFailureLogger.wakeSource(facts.source);
    const wakeId = createHash('sha256').update(typeof facts.wakeId === 'string' ? facts.wakeId : 'unknown').digest('hex').slice(0, 16);
    const { jobId, taskIndex, attempt, graphCache, providerDispatched, liveChildCount, inputTokens, outputTokens } = facts;
    // A live runner can bypass the registry whether cached or evicted.
    const observedHit = { live_runner: null, registry: true, miss: false }[graphCache];
    const cacheHit = typeof facts.cacheHit === 'boolean' ? facts.cacheHit : observedHit;
    this.sink.error(`[agent-job] wake ${ JSON.stringify({
      jobId,
      taskIndex,
      wakeId,
      source,
      attempt,
      graphCache,
      cacheHit,
      providerDispatched,
      liveChildCount,
      inputTokens:  Number.isFinite(inputTokens) ? inputTokens : undefined,
      outputTokens: Number.isFinite(outputTokens) ? outputTokens : undefined,
    }) }`);
  }

  static wakeSource(value: unknown): string {
    return typeof value === 'string' && ['missing_input', 'agent_wait_timer', 'sub_agent_completion', 'orchestrator_job_message',
      'contract_reminder', 'auto_park_resume', 'inject'].includes(value)
? value
: 'unknown_wake';
  }

  observe(previous: AgentJob, next: AgentJob): void {
    try {
      const jobNewlyFailed = previous.status !== 'failed' && next.status === 'failed';
      next.tasks.forEach((task, taskIndex) => {
        const before = previous.tasks[taskIndex];
        let record: AgentJobFailureRecord | undefined;
        if (jobNewlyFailed && this.isLive(task)) {
          record = this.strandedRecordFor(next, task, taskIndex);
        } else {
          if (before?.status === task.status) return;
          // Already logged when the job failed around this still-live task.
          if (previous.status === 'failed' && before && this.isLive(before)) return;
          record = this.recordFor(next, task, taskIndex);
        }
        if (record) this.sink.error(`${ AgentJobFailureLogger.TAG } ${ JSON.stringify(record) }`);
      });
    } catch {
      // Diagnostics must never break the durable job write that triggered them.
    }
  }

  /** A task still live when its job was failed out from under it (e.g. restart recovery limit). */
  strandedRecordFor(job: AgentJob, task: AgentJobTask, taskIndex: number): AgentJobFailureRecord {
    const message = job.error || 'job failed while the task was still live';
    const reason = this.classify('error', message, null);
    return this.build(job, task, taskIndex, message, reason === 'error' ? 'recovery_exhausted' : reason, null);
  }

  /** Builds the log record, or undefined when this transition is not a failure. */
  recordFor(job: AgentJob, task: AgentJobTask, taskIndex: number): AgentJobFailureRecord | undefined {
    if (task.status === 'error' && task.completion?.status === 'completed') return undefined;
    if (task.status !== 'error' && task.status !== 'stopped') return undefined;
    const attribution = task.stoppedBy ?? job.stoppedBy;
    // Human and manager stops are deliberate; only system or unattributed stops are kills.
    if (task.status === 'stopped' && attribution && (attribution === 'human' || 'agentId' in attribution)) return undefined;
    const system = attribution && attribution !== 'human' && 'system' in attribution ? attribution.system : null;
    const message = task.status === 'stopped'
      ? task.stopReason ?? job.stopReason ?? 'stopped without a recorded reason'
      : task.completion?.output || job.results[taskIndex]?.output || task.summary || job.error || 'task failed without a recorded error';
    return this.build(job, task, taskIndex, message, this.classify(task.status, message, system), system);
  }

  private build(job: AgentJob, task: AgentJobTask, taskIndex: number, message: string, reason: AgentJobFailureReason,
    system: string | null): AgentJobFailureRecord {
    const { error, stack } = this.splitStack(this.redact(message));
    const finishedAt = task.finishedAt ?? job.finishedAt ?? null;
    const startedAt = task.startedAt ?? job.createdAt;
    return {
      jobId: job.jobId, taskIndex, agentId: task.agentId, label: task.label,
      parentJobId: job.parentJobId ?? null, threadId: task.threadId ?? null, parentThreadId: job.parentThreadId ?? null,
      runLocation: task.runLocation ?? null, provider: task.provider ?? null, model: task.model ?? null,
      status: task.status, jobStatus: job.status, reason, stoppedBy: system,
      error, ...(stack ? { stack } : {}),
      elapsedMs: finishedAt !== null && Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null,
    };
  }

  classify(status: 'error' | 'stopped', message: string, system: string | null): AgentJobFailureReason {
    if (/^dead run\b/i.test(message) || system === 'SpawnAgentDeadRunWatcher') return 'dead_run';
    if (/^lost: /i.test(message)) return 'lost';
    if (/restart recovery limit/i.test(message)) return 'recovery_exhausted';
    if (/produced no assistant output/i.test(message)) return 'empty_wake';
    if (/remained unprocessed/i.test(message)) return 'unprocessed_result';
    if (/without return(ing|_result)?\b|did not return|no contract/i.test(message)) return 'contract_missing';
    if (/deadline|timed out|timeout/i.test(message)) return 'deadline';
    if (/transport|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|overloaded/i.test(message)) return 'provider_transport';
    return status === 'stopped' ? 'stopped' : 'error';
  }

  /** Stored errors are strings; split off an embedded V8 stack (frames only) so it can be capped separately. */
  private splitStack(message: string): { error: string; stack?: string } {
    const at = message.search(/\n\s+at /);
    const head = at >= 0 ? message.slice(0, at) : message;
    return {
      error: head.slice(0, AgentJobFailureLogger.MAX_ERROR_CHARS),
      ...(at >= 0 ? { stack: message.slice(at + 1).slice(0, AgentJobFailureLogger.MAX_STACK_CHARS) } : {}),
    };
  }

  /** Cheap scrub of obvious credentials that providers sometimes echo into error text. */
  private redact(message: string): string {
    return AgentJobFailureLogger.SECRET_PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), message);
  }

  private isLive(task: AgentJobTask): boolean {
    return ['queued', 'running', 'parked'].includes(task.status) || (task.status === 'blocked' && !task.returnedAt && !task.finishedAt);
  }
}
