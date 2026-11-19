// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentInboxTarget } from './AgentInbox';
import type { AgentJob } from '../tools/agents/jobRegistry';

export interface AgentInboxReceiverResolver { resolve(channel: string, targetId?: string): Promise<AgentInboxTarget> }
export interface AgentInboxJobReader { allJobs(): Promise<AgentJob[]>; activeJobs?(): Promise<AgentJob[]> }
export interface AgentInboxCandidate { channel: string; threadId: string; label: string; jobId?: string; executing?: boolean }

export class NoAgentInboxTargetError extends Error {
  constructor(channel: string, targetId: string) { super(`No ${channel} instance matches "${targetId}". Use a thread ID or job ID from the live roster.`); this.name = 'NoAgentInboxTargetError'; }
}

export class AmbiguousAgentInboxTargetError extends Error {
  constructor(readonly channel: string, readonly candidates: AgentInboxCandidate[]) {
    super(`Ambiguous channel "${channel}". Address one instance explicitly: ${candidates.map(item => `${item.channel}#${item.threadId} (${item.label}${item.jobId ? `, job ${item.jobId}` : ''})`).join('; ')}`);
    this.name = 'AmbiguousAgentInboxTargetError';
  }
}

/** Resolves only unique channel matches; precise selectors never depend on recency. */
export class DurableAgentInboxReceiverResolver implements AgentInboxReceiverResolver {
  constructor(private readonly jobs: AgentInboxJobReader, private readonly activeThreads: (channel: string) => AgentInboxCandidate[]) {}

  async resolve(channel: string, targetId?: string): Promise<AgentInboxTarget> {
    const candidates = [...this.activeThreads(channel)];
    const jobs = await (this.jobs.activeJobs?.() ?? this.jobs.allJobs());
    jobs.sort((left, right) => Number(left.createdAt) - Number(right.createdAt));
    for (const job of jobs) {
      for (const task of job.tasks) {
        if (task.agentId === channel && ['running', 'parked'].includes(task.status) && task.threadId) candidates.push({ channel, threadId: task.threadId, label: task.label, jobId: job.jobId });
      }
      if (job.parentAgentId === channel && ['running', 'parked'].includes(job.status) && job.parentThreadId) candidates.push({ channel, threadId: job.parentThreadId, label: `manager (${job.parentAgentId})`, jobId: job.jobId });
    }
    // Prefer job-bound records over cached graph copies of the same thread.
    const byThread = new Map<string, AgentInboxCandidate>();
    for (const candidate of candidates) {
      const previous = byThread.get(candidate.threadId);
      byThread.set(candidate.threadId, previous ? { ...previous, ...candidate, executing: previous.executing || candidate.executing } : candidate);
    }
    const unique = [...byThread.values()];
    if (targetId) {
      const matches = unique.filter(candidate => candidate.threadId === targetId || candidate.jobId === targetId);
      if (!matches.length) throw new NoAgentInboxTargetError(channel, targetId);
      if (matches.length > 1) throw new AmbiguousAgentInboxTargetError(channel, matches);
      const match = matches[0];
      return { channel, threadId: match.threadId, agentId: channel, jobId: match.jobId, label: match.label };
    }
    const bound = unique.filter(candidate => candidate.jobId);
    const executing = unique.filter(candidate => candidate.executing);
    const ambiguous = bound.length > 1 ? bound : executing.length > 1 ? executing : [];
    if (ambiguous.length > 1) throw new AmbiguousAgentInboxTargetError(channel, ambiguous);
    const preferred = bound.length ? bound : executing;
    if (preferred.length === 1) return { channel, threadId: preferred[0].threadId, agentId: channel, jobId: preferred[0].jobId, label: preferred[0].label };
    if (!bound.length && !executing.length && unique.length > 0) {
      const latest = unique[unique.length - 1];
      return { channel, threadId: latest.threadId, agentId: channel, jobId: latest.jobId, label: latest.label };
    }
    if (unique.length === 1) return { channel, threadId: unique[0].threadId, agentId: channel };
    return { channel, agentId: channel };
  }
}
