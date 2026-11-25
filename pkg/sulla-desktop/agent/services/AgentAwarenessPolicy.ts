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
  static readonly WORKER_AGENT_SLUGS = Object.freeze([
    'codex-luna-worker', 'codex-sol-worker', 'haiku-worker', 'sonnet-worker', 'opus-worker', 'analytics-worker',
  ] as const);
  static readonly DEFAULT_OFF_AGENT_SLUGS = Object.freeze([
    ...AgentAwarenessPolicy.WORKER_AGENT_SLUGS, 'integrator', 'premortem-planner', 'mockup-designer',
  ] as const);

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
