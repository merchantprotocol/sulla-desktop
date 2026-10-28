// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { setTimeout as delay } from 'node:timers/promises';

import { config } from './config.js';

function unwrap(value: any): any {
  let current = value;
  for (let i = 0; i < 8; i++) {
    if (current && typeof current === 'object' && 'result' in current) {
      current = current.result;
      continue;
    }
    if (typeof current === 'string') {
      try { current = JSON.parse(current); continue } catch { /* plain tool output */ }
    }
    break;
  }
  return current;
}

export class ScopedToolClient {
  constructor(private readonly token: string) {}

  async call(tool: string, input: Record<string, unknown>, category = 'meta'): Promise<any> {
    const slash = tool.indexOf('/');
    const resolvedCategory = slash > 0 ? tool.slice(0, slash) : category;
    const resolvedTool = slash > 0 ? tool.slice(slash + 1) : tool;
    const response = await fetch(`${ config.managerUrl }/internal/tools/${ encodeURIComponent(resolvedCategory) }/${ encodeURIComponent(resolvedTool) }`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ this.token }`,
      },
      body: JSON.stringify(input),
    });
    const json = await response.json().catch(() => ({ error: `non-JSON response (${ response.status })` }));
    if (!response.ok) throw new Error(json.error ?? `Tool ${ tool } failed with HTTP ${ response.status }`);
    return unwrap(json);
  }
}

function findJob(value: any, jobId: string): any | null {
  if (!value || typeof value !== 'object') return null;
  if (value.jobId === jobId || value.id === jobId) return value;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findJob(child, jobId);
    if (found) return found;
  }
  return null;
}

export class DesktopAgentLauncher {
  constructor(private readonly tools: ScopedToolClient) {}

  async run(agentId: string, prompt: string, label: string, nodeId?: string, occurrence = 0): Promise<{ output: unknown; threadId?: string }> {
    // `sulla-desktop` is the default Desktop persona, not an agent-definition
    // slug. Treat it exactly like an omitted selector.
    const task = agentId && agentId !== 'sulla-desktop' ? { prompt, agentId, label } : { prompt, label };
    const launched = await this.tools.call('spawn_agent', { tasks: [task] });
    const jobId = launched?.jobId ?? launched?.id;
    if (!jobId) throw new Error(`meta/spawn_agent did not return a job id: ${ JSON.stringify(launched) }`);

    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const snapshot = await this.tools.call('check_agent_jobs', { jobId }, 'agents');
      const job = findJob(snapshot, jobId) ?? snapshot;
      const status = String(job?.status ?? '').toLowerCase();
      if (['completed', 'done', 'succeeded'].includes(status)) {
        return {
          output: job.result?.output ?? job.output ?? job.result ?? job.summary ?? snapshot,
          threadId: job.threadId ?? job.conversationId,
        };
      }
      if (['failed', 'blocked', 'stopped', 'cancelled'].includes(status)) {
        throw new Error(`Agent ${ label } ended ${ status }: ${ job.error ?? job.summary ?? 'no detail' }`);
      }
      await delay(2_000);
    }
    throw new Error(`Agent ${ label } exceeded the 30 minute workflow node limit`);
  }
}

export class ServerAgentLauncher {
  constructor(private readonly token: string) {}

  private async request(path: string, body: Record<string, unknown>): Promise<any> {
    const response = await fetch(`${ config.managerUrl }${ path }`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        Authorization: `Bearer ${ this.token }`,
      },
      body:     JSON.stringify(body),
      redirect: 'error',
      signal:   AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => ({ error: `non-JSON response (${ response.status })` }));
    if (!response.ok) throw new Error(json.error ?? `Agents service request failed (${ response.status })`);
    return json;
  }

  async run(agentId: string, prompt: string, label: string, nodeId?: string, occurrence = 0): Promise<{ output: unknown; threadId?: string }> {
    const launched = await this.request('/internal/agents/runs', { agentId, prompt, label, nodeId, occurrence });
    const runId = typeof launched.id === 'string' ? launched.id : '';
    if (!runId) throw new Error('Agents service did not return a run id');

    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      const run = await this.request('/internal/agents/runs/status', { runId, nodeId, occurrence });
      const status = String(run.status ?? '').toLowerCase();
      if (status === 'completed') return { output: run.output ?? '', threadId: runId };
      if (['failed', 'stopped', 'cancelled'].includes(status)) {
        throw new Error(`Agent ${ label } ended ${ status }: ${ run.error ?? 'no detail' }`);
      }
      await delay(2_000);
    }
    throw new Error(`Agent ${ label } exceeded the 30 minute workflow node limit`);
  }
}
