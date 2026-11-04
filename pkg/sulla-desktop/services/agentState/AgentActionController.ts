// SPDX-License-Identifier: GPL-2.0-or-later
import type { AgentActionResult, AgentStateRow } from '@pkg/shared/agentState/AgentStateSnapshot';
import type { AgentStateClient, AgentStateTransport } from './AgentStateClient';

export class AgentActionController {
  private readonly pending = new Set<string>();
  constructor(private readonly transport: AgentStateTransport, private readonly client: AgentStateClient) {}
  canMessage(row: AgentStateRow): boolean { return row.canMessage && !this.pending.has(`message:${row.key}`) }
  canStop(row: AgentStateRow): boolean { return row.canStop && !this.pending.has(`stop:${row.jobId}`) }
  isPending(action: 'message' | 'stop', row: AgentStateRow): boolean { return this.pending.has(`${action}:${action === 'stop' ? row.jobId : row.key}`) }
  message(row: AgentStateRow, message: string): Promise<AgentActionResult> { return this.run(`message:${row.key}`, 'agents:message-job', [row.jobId, row.taskIndex, message]) }
  stop(row: AgentStateRow): Promise<AgentActionResult> { return this.run(`stop:${row.jobId}`, 'agents:stop-job', [row.jobId]) }
  private async run(key: string, channel: string, args: unknown[]): Promise<AgentActionResult> {
    this.pending.add(key);
    try {
      const result = await this.transport.invoke(channel, ...args) as AgentActionResult;
      if (result.stale && result.snapshot) this.client.apply(result.snapshot);
      return result;
    } finally { this.pending.delete(key) }
  }
}
