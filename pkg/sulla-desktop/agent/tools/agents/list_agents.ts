// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, ToolResponse } from '../base';

/**
 * Directory of the live named agents you can message. Returns each running
 * agent with its channel, status, and uptime — the same roster that appears in
 * turn context, but queryable on demand (e.g. before addressing one).
 *
 * To message any of these, emit a channel tag in your reply:
 *   <channel:heartbeat>your message</channel:heartbeat>
 * Channel messages are fire-and-forget; the agent's reply arrives on your
 * channel on a later turn (it is not a synchronous request/response). For a
 * bounded delegated task, use spawn_agent instead.
 */
export class ListAgentsWorker extends BaseTool {
  name = '';
  description = '';

  protected async _validatedCall(_input: any): Promise<ToolResponse> {
    let agents: any[] = [];
    try {
      const { getActiveAgentsRegistry } = await import('../../services/ActiveAgentsRegistry');
      agents = await getActiveAgentsRegistry().getAllAgents();
    } catch (err) {
      return {
        successBoolean: false,
        responseString: `Could not read the active-agents registry: ${ (err as Error).message }`,
      };
    }

    const now = Date.now();
    const rows: Array<Record<string, any>> = agents
      .filter(a => a.type !== 'human')
      .map(a => ({
        name:        a.name || a.agentId,
        channel:     a.channel,
        status:      a.status,
        uptimeMins:  Math.floor((now - a.startedAt) / 60000),
        idleMins:    Math.floor((now - a.lastActiveAt) / 60000),
        description: a.description,
        statusNote:  a.statusNote && a.statusNote !== 'idle' ? a.statusNote : undefined,
      }));

    try {
      const { getAllJobs } = await import('./jobRegistry');
      const byThread = new Map<string, { row: Record<string, any>; createdAt: number }>();
      for (const job of await getAllJobs()) {
        for (const task of job.tasks) {
          if (!task.threadId || !['running', 'parked'].includes(task.status)) continue;
          const row = { name: task.label, channel: task.agentId, address: `${task.agentId}#${task.threadId}`, threadId: task.threadId, jobId: job.jobId, label: task.label, status: task.status, uptimeMins: 0, idleMins: 0, description: task.label };
          if (!byThread.has(task.threadId) || Number(job.createdAt) > byThread.get(task.threadId)!.createdAt) byThread.set(task.threadId, { row, createdAt: Number(job.createdAt) || 0 });
        }
        if (job.parentAgentId && job.parentThreadId && ['running', 'parked'].includes(job.status)) {
          const row = { name: `Manager ${job.parentAgentId}`, channel: job.parentAgentId, address: `${job.parentAgentId}#${job.parentThreadId}`, threadId: job.parentThreadId, jobId: job.jobId, label: `Manager ${job.parentAgentId}`, status: job.status, uptimeMins: 0, idleMins: 0, description: 'Manager instance' };
          if (!byThread.has(job.parentThreadId) || Number(job.createdAt) > byThread.get(job.parentThreadId)!.createdAt) byThread.set(job.parentThreadId, { row, createdAt: Number(job.createdAt) || 0 });
        }
      }
      const listedThreads = new Set(rows.map(row => row.threadId).filter(Boolean));
      for (const [threadId, item] of byThread) if (!listedThreads.has(threadId)) rows.push(item.row);
    } catch { /* Job instances may be unavailable in minimal runtimes. */ }

    if (rows.length === 0) {
      return {
        successBoolean: true,
        responseString: 'No named agents are currently registered as running.',
      };
    }

    return {
      successBoolean: true,
      responseString: JSON.stringify({
        count:  rows.length,
        agents: rows,
        hint:   'Use <channel:CHANNEL#threadId-or-jobId>text</channel:CHANNEL#threadId-or-jobId> for a precise instance; bare channel names work only when unique.',
      }, null, 2),
    };
  }
}
