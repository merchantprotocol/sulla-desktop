// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Registry for tracking async sub-agent jobs.
 *
 * Two layers, one owner (mirrors the SullaSettingsModel philosophy —
 * the model owns persistence, callers never touch the store directly):
 *   • In-memory Map — the hot cache; source of truth while the app runs.
 *   • Postgres agent_jobs table (migration 0043) — write-through copy so
 *     a restart no longer silently loses running jobs and their results.
 *
 * On first use after boot, stale 'running' rows are swept to 'failed'
 * ("app restarted mid-job") so check_agent_jobs answers honestly instead
 * of "not found". AbortControllers are in-memory ONLY — a signal cannot
 * survive a restart, and after the boot sweep a restarted job is
 * correctly reported dead, so nothing needs one.
 *
 * Jobs are cleaned up after retrieval or after a TTL (1 hour) — this is
 * operational state, not history; rows are really deleted.
 *
 * Every delegation is a job, hidden or tabbed. A tab job holds exactly one
 * task: a live chat tab the human can join. It stays 'running' across turns
 * and app restarts until its child returns its contract or someone stops it,
 * so the boot sweep leaves tab jobs alone.
 */

import { agentJobProvider } from '../../app/Providers/AgentJobServiceProvider';

import type { AgentContractSpec } from './contract';

export type AgentJobVisibility = 'hidden' | 'tab';

export interface AgentJobResult {
  label:    string;
  status:   'completed' | 'blocked' | 'error';
  output:   string;
  threadId: string;
  /** Contract name and the structured value the child returned, if it did. */
  contract?: string;
  result?:   unknown;
  /** Guest cleanup/recovery disposition for container-backed workers. */
  cleanupReceipt?: {
    removedGuestPaths:       string[];
    retainedGuestPaths:      string[];
    recoveryWorkspacePath?:  string;
    workspaceDecisionReason: string;
  };
}

export interface AgentJobTask {
  agentId:    string;
  label:      string;
  prompt:     string;
  /** Per-run routing overrides required to rehydrate this exact agent. */
  provider?: string;
  model?: string;
  runLocation?: 'vm' | 'container';
  /** Restart recovery attempts already consumed. */
  restartResumeCount?: number;
  /** Projects task this child was launched to work, when explicitly supplied. */
  taskId?:    string;
  status:     'queued' | 'running' | 'parked' | 'completed' | 'blocked' | 'error' | 'stopped';
  threadId?:  string;
  startedAt?: number;
  finishedAt?: number;
  dismissed?:  boolean;
  visibility?: AgentJobVisibility;
  contract?:   AgentContractSpec;
  /** Delegation depth of the child (1 = launched by a top-level chat). */
  depth?:      number;
  /** Set once the child called return_result with a contract-valid value. */
  result?:     unknown;
  summary?:    string;
  returnedAt?: number;
  /** Settled result persisted as soon as this task finishes. */
  completion?: AgentJobResult;
  /** Set only after this task's contract is dispatched into a parent turn. */
  completionDeliveredAt?: number;
  /** A hidden child the human opened as a chat tab mid-run. */
  promotedToTab?: boolean;
}

export interface OrphanedChildNotice {
  childJobId: string;
  taskIndex: number;
  managerThreadId: string;
  managerStatus: 'completed' | 'failed' | 'stopped';
  results: AgentJobResult[];
  recordedAt: number;
}

export interface AgentJob {
  jobId:      string;
  status:     'running' | 'parked' | 'completed' | 'failed' | 'stopped';
  createdAt:  number;
  finishedAt: number | null;
  taskCount:  number;
  results:    AgentJobResult[];
  tasks:      AgentJobTask[];
  error?:     string;
  parentChannel?: string;
  parentThreadId?: string;
  parentAgentId?: string;
  visibility?: AgentJobVisibility;
  projectTaskIds?: string[];
  completionDeliveredAt?: number | null;
  waitingOnChildren?: number;
  restartResumeCount?: number;
  dismissedAt?: number | null;
  orphanedChildNotices?: OrphanedChildNotice[];
}

export interface CreateJobOptions {
  visibility?:    AgentJobVisibility;
  parentAgentId?: string;
}

export const MAX_SUBAGENT_DEPTH = 3;

export const createJob = (...args: Parameters<typeof agentJobProvider.service.createJob>) => agentJobProvider.service.createJob(...args);
export const updateJobTask = (...args: Parameters<typeof agentJobProvider.service.updateJobTask>) => agentJobProvider.service.updateJobTask(...args);
export const getJobsForParentThread = (...args: Parameters<typeof agentJobProvider.service.getJobsForParentThread>) => agentJobProvider.service.getJobsForParentThread(...args);
export const dismissJobTask = (...args: Parameters<typeof agentJobProvider.service.dismissJobTask>) => agentJobProvider.service.dismissJobTask(...args);
export const registerJobWatcher = (...args: Parameters<typeof agentJobProvider.service.registerJobWatcher>) => agentJobProvider.service.registerJobWatcher(...args);
export const releaseJobWatcher = (...args: Parameters<typeof agentJobProvider.service.releaseJobWatcher>) => agentJobProvider.service.releaseJobWatcher(...args);
export const getJobAbortSignal = (...args: Parameters<typeof agentJobProvider.service.getJobAbortSignal>) => agentJobProvider.service.getJobAbortSignal(...args);
export const abortJob = (...args: Parameters<typeof agentJobProvider.service.abortJob>) => agentJobProvider.service.abortJob(...args);
export const stopJobCascade = (...args: Parameters<typeof agentJobProvider.service.stopJobCascade>) => agentJobProvider.service.stopJobCascade(...args);
export const getJob = (...args: Parameters<typeof agentJobProvider.service.getJob>) => agentJobProvider.service.getJob(...args);
export const getAllJobs = (...args: Parameters<typeof agentJobProvider.service.getAllJobs>) => agentJobProvider.service.getAllJobs(...args);
export const boundJobList = (...args: Parameters<typeof agentJobProvider.service.boundJobList>) => agentJobProvider.service.boundJobList(...args);
export const getJobsForList = (...args: Parameters<typeof agentJobProvider.service.getJobsForList>) => agentJobProvider.service.getJobsForList(...args);
export const parkJobTask = (...args: Parameters<typeof agentJobProvider.service.parkJobTask>) => agentJobProvider.service.parkJobTask(...args);
export const resumeParkedJob = (...args: Parameters<typeof agentJobProvider.service.resumeParkedJob>) => agentJobProvider.service.resumeParkedJob(...args);
export const completeJob = (...args: Parameters<typeof agentJobProvider.service.completeJob>) => agentJobProvider.service.completeJob(...args);
export const recordTaskCompletion = (...args: Parameters<typeof agentJobProvider.service.recordTaskCompletion>) => agentJobProvider.service.recordTaskCompletion(...args);
export const markTaskCompletionDelivered = (...args: Parameters<typeof agentJobProvider.service.markTaskCompletionDelivered>) => agentJobProvider.service.markTaskCompletionDelivered(...args);
export const markCompletionDelivered = (...args: Parameters<typeof agentJobProvider.service.markCompletionDelivered>) => agentJobProvider.service.markCompletionDelivered(...args);
export const getPendingCompletions = (...args: Parameters<typeof agentJobProvider.service.getPendingCompletions>) => agentJobProvider.service.getPendingCompletions(...args);
export const findTaskByThread = (...args: Parameters<typeof agentJobProvider.service.findTaskByThread>) => agentJobProvider.service.findTaskByThread(...args);
export const delegationDepthForThread = (...args: Parameters<typeof agentJobProvider.service.delegationDepthForThread>) => agentJobProvider.service.delegationDepthForThread(...args);
export const resolveAgentDepth = (...args: Parameters<typeof agentJobProvider.service.resolveAgentDepth>) => agentJobProvider.service.resolveAgentDepth(...args);
export const countOpenTabJobs = (...args: Parameters<typeof agentJobProvider.service.countOpenTabJobs>) => agentJobProvider.service.countOpenTabJobs(...args);
export const recordTaskReturn = (...args: Parameters<typeof agentJobProvider.service.recordTaskReturn>) => agentJobProvider.service.recordTaskReturn(...args);
export const markTaskPromoted = (...args: Parameters<typeof agentJobProvider.service.markTaskPromoted>) => agentJobProvider.service.markTaskPromoted(...args);
export const failJob = (...args: Parameters<typeof agentJobProvider.service.failJob>) => agentJobProvider.service.failJob(...args);
