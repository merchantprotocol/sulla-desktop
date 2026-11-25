// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentAwarenessDefaults } from './AgentAwarenessDefaults';

export interface AgentAwarenessSetting {
  agent_awareness?: boolean | null;
  agentAwareness?:  boolean | null;
}

export interface AgentAwarenessDefinitionLookup {
  findBySlug(slug: string): Promise<AgentAwarenessSetting | null>;
}

/** One policy for prompt context and direct agent-launch tool exposure. */
export class AgentAwarenessPolicy {
  static readonly WORKER_AGENT_SLUGS = AgentAwarenessDefaults.WORKER_AGENT_SLUGS;
  static readonly DEFAULT_OFF_AGENT_SLUGS = AgentAwarenessDefaults.DEFAULT_OFF_AGENT_SLUGS;

  constructor(private readonly definitions?: AgentAwarenessDefinitionLookup) {}

  private readonly launchingToolNames = new Set([
    'spawn_agent',
    'agents_directory',
    'list_agents',
    'check_agent_jobs',
    'send_job_message',
    'stop_agent_job',
    'start_agent_conversation',
    'send_agent_message',
    'read_agent_conversation',
    'close_agent_conversation',
    'promote_to_tab',
  ]);

  canSeeOtherAgents(setting?: AgentAwarenessSetting | null): boolean {
    const value = typeof setting?.agent_awareness === 'boolean'
      ? setting.agent_awareness
      : setting?.agentAwareness;
    return value !== false;
  }

  async canSeeOtherAgentsForAgent(agentId: string | null, fallback?: AgentAwarenessSetting | null): Promise<boolean> {
    if (agentId && this.definitions) {
      try {
        return this.canSeeOtherAgents(await this.definitions.findBySlug(agentId));
      } catch { /* a failed refresh may use the last known value; otherwise default visible */ }
    }
    return this.canSeeOtherAgents(fallback);
  }

  async refreshAgentAwareness(metadata: { agentAwareness?: boolean }, agentId: string | null): Promise<boolean> {
    return metadata.agentAwareness = await this.canSeeOtherAgentsForAgent(agentId, { agent_awareness: metadata.agentAwareness });
  }

  agentNetworkStatement(setting?: AgentAwarenessSetting | null): string {
    return this.canSeeOtherAgents(setting) ? 'You are part of a live multi-agent network — Heartbeat and other agents are active and messageable' : '';
  }

  agentNetworkDirective(setting?: AgentAwarenessSetting | null): string {
    const statement = this.agentNetworkStatement(setting);
    return statement ? `- ${ statement }` : '';
  }

  agentBackgroundWorkDirective(setting?: AgentAwarenessSetting | null): string {
    return this.canSeeOtherAgents(setting)
      ? '- Background work (Bash run_in_background, Monitor): if it finishes after your turn ends, Sulla wakes this conversation with the completion so you can act on it. Sub-agent and workflow-worker runs are NOT woken after they return — there, wait for the result inside the same turn (bounded loop) instead of promising to report back later'
      : '';
  }

  allowsTool(metadata: unknown, toolName: string): boolean {
    return this.canSeeOtherAgents(metadata as AgentAwarenessSetting | null | undefined)
      || !this.isLaunchingToolName(toolName);
  }

  filterTurnContext(text: string, setting?: AgentAwarenessSetting | null): string {
    if (this.canSeeOtherAgents(setting)) return text;
    const openingTag = '<turn_context>';
    const closingTag = '</turn_context>';
    const output: string[] = [];
    let cursor = 0;

    while (cursor < text.length) {
      const blockStart = text.indexOf(openingTag, cursor);
      if (blockStart < 0) {
        output.push(text.slice(cursor));
        break;
      }

      const contentStart = blockStart + openingTag.length;
      const blockEnd = text.indexOf(closingTag, contentStart);
      if (blockEnd < 0) {
        output.push(text.slice(cursor));
        break;
      }

      output.push(text.slice(cursor, contentStart));
      output.push(this.removeRosterLines(text.slice(contentStart, blockEnd)));
      output.push(closingTag);
      cursor = blockEnd + closingTag.length;
    }

    return output.join('');
  }

  filterHistoricalMessages<T extends { content: unknown }>(messages: readonly T[], setting?: AgentAwarenessSetting | null): T[] {
    if (this.canSeeOtherAgents(setting)) return [...messages];
    return messages.map(message => ({ ...message, content: this.filterHistoricalContent(message.content, setting) }));
  }

  filterContextFields<T extends readonly [string, unknown]>(fields: readonly T[], setting?: AgentAwarenessSetting | null, supportSessionId?: string): T[] {
    const visible = this.canSeeOtherAgents(setting)
      ? fields
      : fields.filter(([tag]) => tag !== 'team_directory' && tag !== 'subagent_directory');
    return (supportSessionId ? visible.filter(([tag]) => tag === 'support_context') : visible) as T[];
  }

  private filterHistoricalContent(content: unknown, setting?: AgentAwarenessSetting | null): unknown {
    if (typeof content === 'string') return this.filterTurnContext(content, setting);
    if (!Array.isArray(content)) return content;
    return content.map(block => block && typeof block === 'object' && 'type' in block && block.type === 'text'
      && 'text' in block && typeof block.text === 'string'
      ? { ...block, text: this.filterTurnContext(block.text, setting) }
      : block);
  }

  private removeRosterLines(context: string): string {
    return context.split('\n').filter(line => !line.trimStart().startsWith('agents:')).join('\n');
  }

  filterToolNames(names: readonly string[], setting?: AgentAwarenessSetting | null): string[] {
    return this.canSeeOtherAgents(setting) ? [...names] : names.filter(name => this.allowsTool(setting, name));
  }

  filterTools<T>(tools: readonly T[], setting?: AgentAwarenessSetting | null): T[] {
    return this.canSeeOtherAgents(setting) ? [...tools] : tools.filter(tool => this.allowsTool(setting, this.toolName(tool)));
  }

  /** Accepts bare, slash-qualified (agents/directory) and underscore-qualified (agents_spawn_agent) names. */
  private isLaunchingToolName(name: string): boolean {
    const normalized = name.trim().toLowerCase().replace(/\//g, '_');
    return this.launchingToolNames.has(normalized) || this.launchingToolNames.has(normalized.replace(/^(?:agents|meta)_/, ''));
  }

  private toolName(value: unknown): string {
    if (!value || typeof value !== 'object') return '';
    const tool = value as { name?: unknown; function?: { name?: unknown } };
    return typeof tool.function?.name === 'string' ? tool.function.name : typeof tool.name === 'string' ? tool.name : '';
  }
}
