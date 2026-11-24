// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface AgentAwarenessSetting {
  agent_awareness?: boolean | null;
  agentAwareness?:  boolean | null;
}

/** One policy for prompt context and direct agent-launch tool exposure. */
export class AgentAwarenessPolicy {
  private readonly launchingToolNames = new Set([
    'spawn_agent',
    'agents_directory',
    'list_agents',
    'check_agent_jobs',
    'send_job_message',
    'stop_agent_job',
  ]);

  canSeeOtherAgents(setting?: AgentAwarenessSetting | null): boolean {
    const value = typeof setting?.agent_awareness === 'boolean'
      ? setting.agent_awareness
      : setting?.agentAwareness;
    return value !== false;
  }

  filterRuntimeContext(parts: readonly string[], setting?: AgentAwarenessSetting | null): string[] {
    if (this.canSeeOtherAgents(setting)) return [...parts];
    return parts.map(part => part
      .replace(/^- You are part of a live multi-agent network[^\n]*\n?/gm, '')
      .replace(/\n{3,}/g, '\n\n'));
  }

  filterTurnContext(text: string, setting?: AgentAwarenessSetting | null): string {
    if (this.canSeeOtherAgents(setting)) return text;
    return text.replace(/(^|\n)agents:[^\n]*(?=\n<\/turn_context>)/gm, '$1');
  }

  filterToolNames(names: readonly string[], setting?: AgentAwarenessSetting | null): string[] {
    return this.canSeeOtherAgents(setting) ? [...names] : names.filter(name => !this.isLaunchingToolName(name));
  }

  filterTools<T>(tools: readonly T[], setting?: AgentAwarenessSetting | null): T[] {
    return this.canSeeOtherAgents(setting) ? [...tools] : tools.filter(tool => !this.isLaunchingToolName(this.toolName(tool)));
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
