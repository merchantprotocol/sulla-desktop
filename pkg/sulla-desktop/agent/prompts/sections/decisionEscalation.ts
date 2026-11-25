// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentAwarenessPolicy } from '../../services/AgentAwarenessPolicy';
import type { PromptBuildContext, PromptSection } from '../SystemPromptBuilder';

export const DECISION_ESCALATION_GUIDANCE = `## Questions from your sub-agents

A \`[Decision from <agent> (decision <id>)]\` is a question from one of your sub-agents. If your brief or the human's stated rules give the answer, use \`sulla agents/answer_decision\` with that decision id and \`action:"answer"\`; otherwise pass it up with a short note. Never guess for the human, re-ask with \`ask_user_question\`, or approve anything.`;

/** Only agents with both network awareness and an agent-management tool need holder guidance. */
export class DecisionEscalationPromptSection {
  private readonly managerToolNames = [
    'spawn_agent', 'agents_directory', 'list_agents', 'check_agent_jobs', 'send_job_message', 'stop_agent_job',
    'start_agent_conversation', 'send_agent_message', 'read_agent_conversation', 'close_agent_conversation', 'promote_to_tab', 'answer_decision',
  ] as const;

  constructor(private readonly awarenessPolicy = new AgentAwarenessPolicy()) {}

  build(ctx: PromptBuildContext): PromptSection | null {
    if (!this.awarenessPolicy.canSeeOtherAgents({ agent_awareness: ctx.agentAwareness }) || !this.canManageAgents(ctx)) return null;
    return { id: 'decision_escalation', content: DECISION_ESCALATION_GUIDANCE, priority: 41, cacheStability: 'stable' };
  }

  private canManageAgents(ctx: PromptBuildContext): boolean {
    const tools = ctx.agentConfig?.tools;
    if (!tools?.length) return true;
    return tools.some(tool => {
      const normalized = tool.trim().toLowerCase().replace(/\//g, '_').replace(/^(?:agents|meta)_/, '');
      return this.managerToolNames.includes(normalized as typeof this.managerToolNames[number]);
    });
  }
}

export function buildDecisionEscalationSection(ctx: PromptBuildContext): PromptSection | null {
  return new DecisionEscalationPromptSection(ctx.agentAwarenessPolicy).build(ctx);
}
