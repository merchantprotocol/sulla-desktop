// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { agentJobProvider } from '../app/Providers/AgentJobServiceProvider';
import type { AgentFleetProjectionService } from '../app/Services/AgentFleetProjectionService';
import type { FleetJobView, FleetTaskView } from '../app/Services/AgentFleetTypes';
import { AgentTeamRollupProjector, type AgentTeamRollup } from '../app/Services/AgentTeamRollupProjector';

export const SUBAGENT_STALL_MS = 15 * 60_000;
export const SUBAGENT_DONE_TTL_MS = 60 * 60_000;
export const SUBAGENT_DIRECTORY_MAX_CHARS = 3000;

interface ChildRow { line: string; stalled: boolean; undelivered: boolean; label: string; output: unknown; }

/** Builds the bounded per-turn direct-child directory from one authoritative fleet read. */
export class SubagentDirectoryBuilder {
  constructor(
    private readonly fleet: AgentFleetProjectionService,
    private readonly rollups: AgentTeamRollupProjector,
    private readonly now: () => number = Date.now,
  ) {}

  async build(parentThreadId: string | undefined): Promise<string> {
    if (!parentThreadId) return '';
    const jobs = await this.fleet.list({ scope: 'mine', callerThreadId: parentThreadId, limit: 100, includeFinished: true });
    if (jobs.length === 0) return '';
    const teams = this.rollups.project(jobs);
    const rows = jobs.filter(job => job.parentJobId === null).flatMap(job => job.tasks.map(task => this.describe(job, task, teams.get(this.rollups.key(job.jobId, task.taskIndex)))).filter((row): row is ChildRow => !!row));
    if (rows.length === 0) return '';
    const out = ['## Your subagents', 'Direct children launched from this conversation (hidden and tab), with descendant teams rolled up. Control them with agents/check_agent_jobs, agents/send_job_message, agents/stop_agent_job.'];
    let size = out.join('\n').length;
    for (const [index, row] of rows.entries()) {
      if (size + row.line.length + 1 > SUBAGENT_DIRECTORY_MAX_CHARS) { out.push(`- …${ rows.length - index } more: \`sulla agents/check_agent_jobs\``); break; }
      out.push(row.line); size += row.line.length + 1;
    }
    const pending = rows.filter(row => row.undelivered).map(row => `- ${ row.label }: ${ this.quote(String(row.output ?? ''), 160) }`);
    if (pending.length) out.push('', '### Results not yet processed', 'These returned but have not reached you as a wake yet. Use them now:', ...pending);
    const stalled = rows.filter(row => row.stalled).length;
    if (stalled) out.push('', `⚠ ${ stalled } open child${ stalled === 1 ? ' looks' : 'ren look' } stalled (no activity for 15+ min). Check it, message it, or stop and relaunch it this turn.`);
    return out.join('\n').slice(0, SUBAGENT_DIRECTORY_MAX_CHARS);
  }

  private describe(job: FleetJobView, task: FleetTaskView, team?: AgentTeamRollup): ChildRow | null {
    const finishedAt = task.finishedAt ? Date.parse(task.finishedAt) : job.finishedAt ? Date.parse(job.finishedAt) : undefined;
    const open = ['running', 'parked'].includes(job.status) && ['running', 'queued', 'parked', 'blocked'].includes(task.status);
    if (!open && task.completionDeliveredAt && finishedAt && this.now() - finishedAt > SUBAGENT_DONE_TTL_MS) return null;
    const lastActivity = Date.parse(task.lastActivityAt); const stalled = open && this.now() - lastActivity >= SUBAGENT_STALL_MS;
    const parts = [task.agentId, String(task.visibility ?? 'hidden'), open ? `${ task.status } ${ this.span(this.now() - Date.parse(task.startedAt)) }` : `${ task.returned ? 'returned' : task.status }`, `contract ${ String(task.contract ?? 'result') }`];
    if (task.latestCheckin) parts.push(`last check-in ${ this.ago(this.now() - Date.parse(task.latestCheckin.time)) } ${ this.quote(task.latestCheckin.summary) }`);
    else if (open) parts.push('no check-in yet');
    if (task.latestCheckin?.blockers.length) parts.push(`blockers: ${ this.quote(task.latestCheckin.blockers.join('; ')) }`);
    if (team) parts.push(this.team(team));
    if (stalled) parts.push(`⚠ stalled (quiet ${ this.span(this.now() - lastActivity) })`);
    parts.push(`job ${ job.tasks.length > 1 ? `${ job.jobId }#${ task.taskIndex }` : job.jobId }`);
    return { line: `- ${ parts.join(' · ') }`, stalled, undelivered: !open && (task.returned || !!task.completion) && !task.completionDeliveredAt, label: task.label || task.agentId, output: task.completion ?? task.result };
  }

  private team(team: AgentTeamRollup): string {
    const states = Object.entries(team.states).sort(([a], [b]) => a.localeCompare(b)).map(([state, count]) => `${ state }=${ count }`).join(' ');
    const quiet = team.oldestQuietAgeMs === null ? '' : ` · oldest quiet ${ this.span(team.oldestQuietAgeMs) }`;
    return `team workers ${ states }${ quiet } · blockers ${ team.openBlockers } · unprocessed ${ team.unprocessedResults }`;
  }

  private ago(ms: number): string { return ms < 60_000 ? 'just now' : `${ this.span(ms) } ago`; }
  private span(ms: number): string { const minutes = Math.max(0, Math.floor(ms / 60_000)); return minutes < 60 ? `${ minutes }m` : `${ Math.floor(minutes / 60) }h ${ minutes % 60 }m`; }
  private quote(text: string, max = 80): string { const flat = text.replace(/\s+/g, ' ').trim(); return `"${ flat.length > max ? `${ flat.slice(0, max) }…` : flat }"`; }
}

/** Compatibility entry point used by SubconsciousMiddleware. */
export async function buildSubagentDirectoryContext(parentThreadId: string | undefined, now = Date.now()): Promise<string> {
  return new SubagentDirectoryBuilder(agentJobProvider.fleet, new AgentTeamRollupProjector(() => now), () => now).build(parentThreadId);
}
