// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentJob, AgentJobTask } from '../../tools/agents/jobRegistry';

/** Receives every committed job write so task failures can be reported at one choke point. */
export interface AgentJobFailureObserver {
  observe(previous: AgentJob, next: AgentJob): void;
}

/** The background-log writer (Logging.background in production). */
export interface AgentJobFailureLogSink {
  error(message: string): void;
}

export type AgentJobFailureReason = 'dead_run' | 'empty_wake' | 'unprocessed_result' | 'contract_missing' | 'deadline' | 'provider_transport' | 'stopped' | 'error';

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
  status: 'error' | 'stopped';
  reason: AgentJobFailureReason;
  stoppedBy: string | null;
  error: string;
  stack?: string;
  elapsedMs: number | null;
}

/**
 * Writes exactly one `[agent-job] task failed` line to background.log when a
 * task newly enters `error`, or `stopped` without a human/agent principal
 * (system kills such as the dead-run watcher). It compares the row before and
 * after each committed write, so repeated rewrites of an already-failed task
 * never log twice and completed tasks never log.
 */
export class AgentJobFailureLogger implements AgentJobFailureObserver {
  static readonly TAG = '[agent-job] task failed';
  static readonly MAX_ERROR_CHARS = 2_048;
  static readonly MAX_STACK_CHARS = 4_096;

  constructor(private readonly sink: AgentJobFailureLogSink) {}

  observe(previous: AgentJob, next: AgentJob): void {
    try {
      next.tasks.forEach((task, taskIndex) => {
        const before = previous.tasks[taskIndex];
        if (before?.status === task.status) return;
        const record = this.recordFor(next, task, taskIndex);
        if (record) this.sink.error(`${ AgentJobFailureLogger.TAG } ${ JSON.stringify(record) }`);
      });
    } catch {
      // Diagnostics must never break the durable job write that triggered them.
    }
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
      : task.completion?.output || job.results[taskIndex]?.output || job.error || 'task failed without a recorded error';
    const { error, stack } = this.splitStack(message);
    const finishedAt = task.finishedAt ?? job.finishedAt ?? null;
    const startedAt = task.startedAt ?? job.createdAt;
    return {
      jobId: job.jobId, taskIndex, agentId: task.agentId, label: task.label,
      parentJobId: job.parentJobId ?? null, threadId: task.threadId ?? null, parentThreadId: job.parentThreadId ?? null,
      runLocation: task.runLocation ?? null, provider: task.provider ?? null, model: task.model ?? null,
      status: task.status, reason: this.classify(task.status, message, system), stoppedBy: system,
      error, ...(stack ? { stack } : {}),
      elapsedMs: finishedAt !== null && Number.isFinite(startedAt) ? Math.max(0, finishedAt - startedAt) : null,
    };
  }

  classify(status: 'error' | 'stopped', message: string, system: string | null): AgentJobFailureReason {
    if (/^dead run\b/i.test(message) || system === 'SpawnAgentDeadRunWatcher') return 'dead_run';
    if (/produced no assistant output/i.test(message)) return 'empty_wake';
    if (/remained unprocessed/i.test(message)) return 'unprocessed_result';
    if (/without return(ing|_result)?\b|did not return|no contract/i.test(message)) return 'contract_missing';
    if (/deadline|timed out|timeout/i.test(message)) return 'deadline';
    if (/transport|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up|fetch failed|overloaded/i.test(message)) return 'provider_transport';
    return status === 'stopped' ? 'stopped' : 'error';
  }

  /** Stored errors are strings; split off an embedded V8 stack so it can be capped separately. */
  private splitStack(message: string): { error: string; stack?: string } {
    const at = message.search(/\n\s+at /);
    const head = at >= 0 ? message.slice(0, at) : message;
    return {
      error: head.slice(0, AgentJobFailureLogger.MAX_ERROR_CHARS),
      ...(at >= 0 ? { stack: message.slice(0, AgentJobFailureLogger.MAX_STACK_CHARS) } : {}),
    };
  }
}
