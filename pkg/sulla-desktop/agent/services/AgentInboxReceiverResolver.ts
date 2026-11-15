// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import type { AgentInboxTarget } from './AgentInbox';
import type { AgentJob } from '../tools/agents/jobRegistry';

export interface AgentInboxReceiverResolver { resolve(channel: string): Promise<AgentInboxTarget> }
export interface AgentInboxJobReader { allJobs(): Promise<AgentJob[]>; activeJobs?(): Promise<AgentJob[]> }

/** Resolves a channel to its own persona and durable parked thread; never falls back to Sulla for named agents. */
export class DurableAgentInboxReceiverResolver implements AgentInboxReceiverResolver {
  constructor(private readonly jobs: AgentInboxJobReader, private readonly activeThread: (channel: string) => string | undefined) {}

  async resolve(channel: string): Promise<AgentInboxTarget> {
    const agentId = channel;
    const liveThread = this.activeThread(channel);
    if (liveThread) return { channel, threadId: liveThread, agentId };
    const jobs = await (this.jobs.activeJobs?.() ?? this.jobs.allJobs());
    for (const job of jobs.sort((a,b) => b.createdAt-a.createdAt)) {
      const task = job.tasks.find(candidate => candidate.agentId===agentId && candidate.status==='parked' && candidate.threadId);
      if (task?.threadId) return { channel, threadId: task.threadId, agentId };
      if (job.parentAgentId===agentId && job.status==='parked' && job.parentThreadId) return { channel, threadId: job.parentThreadId, agentId };
    }
    return { channel, agentId };
  }
}
