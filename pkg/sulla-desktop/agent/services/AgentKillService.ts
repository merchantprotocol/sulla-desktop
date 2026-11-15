// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import { StopPrincipal } from '../app/ValueObjects/StopPrincipal';
import { stopAgentTab } from './AgentTabOpener';
import { AgentTurnStopper, type TurnStopper } from './AgentTurnStopper';
import { emitSubAgentExchange } from '../tools/agents/jobExchange';
import { SULLA_DESKTOP_CHANNEL_ID } from './ChatAgentRouting';
import { agentLaunchPauseService, type AgentLaunchPauseState } from './AgentLaunchPauseService';
import type { AgentJob } from '../tools/agents/jobRegistry';

export interface AgentKillResult { ok: boolean; killedJobs: number; error?: string }
export interface KillJobStore { allJobs(): Promise<AgentJob[]>; activeJobs?(): Promise<AgentJob[]> }
export type StopTree = (jobId: string, principal: ReturnType<typeof StopPrincipal.human>, reason: string) => Promise<'stopped' | 'not-found' | 'already-finished' | 'forbidden'>;

/** Human-only fleet kill orchestration. Persistence happens before runtime aborts. */
export class AgentKillService {
  constructor(
    private readonly jobs: KillJobStore = agentJobProvider.jobs,
    private readonly stopTree: StopTree = agentJobProvider.service.stopJobCascade.bind(agentJobProvider.service),
    private readonly tabStopper: (threadId: string, reason: string) => Promise<void> = stopAgentTab,
    private readonly turnStopper: TurnStopper = new AgentTurnStopper(),
    private readonly publishExchange: typeof emitSubAgentExchange = emitSubAgentExchange,
  ) {}

  async liveDescendantCount(threadId: string): Promise<number> {
    return (await this.descendants(threadId)).filter(job => this.isLive(job)).length;
  }

  async killTree(threadId: string): Promise<AgentKillResult> {
    try {
      const descendants = await this.descendants(threadId);
      let killedJobs = 0;
      for (const job of descendants.filter(job => this.isLive(job))) {
        const outcome = await this.stopTree(job.jobId, StopPrincipal.human(), 'Killed by human from Live Agents');
        if (outcome === 'stopped') killedJobs++;
        for (const [taskIndex, task] of job.tasks.entries()) {
          await this.publishExchange(job.parentChannel, job.parentThreadId, {
            direction: 'from_agent', agentId: task.agentId, label: task.label,
            summary: `${ task.label } was killed by human`, detail: 'Killed by human. Its result will not be delivered.',
            status: 'stopped', jobId: job.jobId, taskIndex, conversationId: task.threadId,
          });
          if (job.visibility === 'tab' && task.threadId) await this.tabStopper(task.threadId, 'Killed by human from Live Agents');
        }
      }
      const rootChannel = descendants.find(job => job.parentThreadId === threadId)?.parentChannel ?? SULLA_DESKTOP_CHANNEL_ID;
      await this.turnStopper.stop(rootChannel, threadId);
      return { ok: true, killedJobs };
    } catch (error) {
      return { ok: false, killedJobs: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async switchState(): Promise<AgentLaunchPauseState> { return agentLaunchPauseService.state(); }

  async setSwitch(on: boolean): Promise<AgentKillResult> {
    try {
      await agentLaunchPauseService.set(on);
      if (!on) return { ok: true, killedJobs: 0 };
      const live = (await (this.jobs.activeJobs?.() ?? this.jobs.allJobs())).filter(job => this.isLive(job));
      const rootThreads = new Set(live.map(job => job.parentThreadId).filter((id): id is string => Boolean(id)));
      let killedJobs = 0;
      for (const threadId of rootThreads) {
        const result = await this.killTree(threadId);
        if (!result.ok) return result;
        killedJobs += result.killedJobs;
      }
      return { ok: true, killedJobs };
    } catch (error) {
      return { ok: false, killedJobs: 0, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private isLive(job: AgentJob): boolean { return job.status === 'running' || job.status === 'parked'; }

  private async descendants(threadId: string): Promise<AgentJob[]> {
    const jobs = await (this.jobs.activeJobs?.() ?? this.jobs.allJobs());
    const discovered = new Set([threadId]);
    const result: AgentJob[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const job of jobs) {
        if (!job.parentThreadId || !discovered.has(job.parentThreadId) || result.includes(job)) continue;
        result.push(job); changed = true;
        for (const task of job.tasks) if (task.threadId) discovered.add(task.threadId);
      }
    }
    return result;
  }
}

export const agentKillService = new AgentKillService();
