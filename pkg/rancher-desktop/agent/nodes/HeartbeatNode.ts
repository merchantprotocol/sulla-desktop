// HeartbeatNode.ts
// Autonomous heartbeat node — gathers project & skills context,
// builds a rich autonomous prompt, and delegates to a fresh AgentGraph
// sub-execution each cycle. The heartbeat graph loops this node until
// the agent reports DONE/BLOCKED or hits max iterations.

import { BaseNode } from './BaseNode';
import type { BaseThreadState, NodeResult, AgentGraphState } from './Graph';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';
import { heartbeatPrompt } from '../prompts/heartbeat';

// ============================================================================
// HEARTBEAT THREAD STATE
// ============================================================================

export interface HeartbeatThreadState extends BaseThreadState {
  messages: ChatMessage[];
  metadata: BaseThreadState['metadata'] & {
    // Project context loaded at heartbeat start
    activeProjects:  string;
    availableSkills: string;

    // Heartbeat tracking
    heartbeatCycleCount:       number;
    heartbeatMaxCycles:        number;
    heartbeatStatus:           'running' | 'done' | 'blocked' | 'idle';
    heartbeatLastCycleSummary: string;

    // What the agent decided to work on
    currentFocus: string;
    focusReason:  string;

    // Environmental context (loaded each cycle from Redis)
    agentsContext: string;
  };
}

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_HEARTBEAT_CYCLES = 10;
const HEARTBEAT_WS_CHANNEL = 'heartbeat';

// ============================================================================
// NODE
// ============================================================================

/**
 * Heartbeat Node — Autonomous agent execution triggered by the heartbeat scheduler.
 *
 * Each cycle:
 *   1. Loads active projects and available skills from registries
 *   2. Builds a rich autonomous prompt combining the heartbeat directive,
 *      project context, skills inventory, and any prior cycle summaries
 *   3. Spawns a fresh AgentGraph (InputHandler → Agent loop) with this prompt
 *      injected as a user message
 *   4. Captures the agent's outcome (DONE/BLOCKED/CONTINUE) and stores it
 *   5. Returns to the heartbeat graph's conditional edge for loop/exit decision
 *
 * The AgentGraph has full tool access — it can use project tools, skill tools,
 * exec, docker, n8n, playwright, memory, calendar, etc.
 */
export class HeartbeatNode extends BaseNode {
  constructor() {
    super('heartbeat', 'Heartbeat');
  }

  async execute(state: HeartbeatThreadState): Promise<NodeResult<HeartbeatThreadState>> {
    const cycleStart = Date.now();
    const cycleNum = (state.metadata.heartbeatCycleCount || 0) + 1;
    state.metadata.heartbeatCycleCount = cycleNum;

    console.log(`[HeartbeatNode] ═══ Cycle ${ cycleNum }/${ state.metadata.heartbeatMaxCycles || MAX_HEARTBEAT_CYCLES } ═══`);

    // ----------------------------------------------------------------
    // 1. GATHER CONTEXT — projects & skills (lazy, once per heartbeat run)
    // ----------------------------------------------------------------
    if (!state.metadata.activeProjects) {
      state.metadata.activeProjects = await this.loadActiveProjects();
    }
    if (!state.metadata.availableSkills) {
      state.metadata.availableSkills = await this.loadAvailableSkills();
    }

    // ----------------------------------------------------------------
    // 1b. ENVIRONMENTAL CONTEXT — active agents, channels, human presence
    // ----------------------------------------------------------------
    state.metadata.agentsContext = await this.loadActiveAgentsContext();

    // ----------------------------------------------------------------
    // 2. BUILD AUTONOMOUS PROMPT
    // ----------------------------------------------------------------
    const autonomousPrompt = this.buildAutonomousPrompt(state);

    // ----------------------------------------------------------------
    // 3. SPAWN AGENT GRAPH — fresh thread, full tool access
    // ----------------------------------------------------------------
    // Lazy import to avoid circular dependency (Graph.ts imports HeartbeatNode)
    const { createAgentGraph } = await import('./Graph');
    const agentGraph = createAgentGraph();
    const agentState = this.buildAgentState(state, autonomousPrompt);

    console.log(`[HeartbeatNode] Spawning AgentGraph (threadId=${ agentState.metadata.threadId })`);

    try {
      await agentGraph.execute(agentState, 'input_handler');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log('[HeartbeatNode] AgentGraph aborted');
        state.metadata.heartbeatStatus = 'done';
        return { state, decision: { type: 'end' } };
      }
      console.error('[HeartbeatNode] AgentGraph execution error:', err);
    } finally {
      await agentGraph.destroy();
    }

    // ----------------------------------------------------------------
    // 4. CAPTURE OUTCOME from agent sub-graph
    // ----------------------------------------------------------------
    const agentMeta = (agentState.metadata as any).agent || {};
    const agentStatus = String(agentMeta.status || 'in_progress').toLowerCase();

    // Extract useful summary from the agent's conversation
    const lastAssistant = [...agentState.messages]
      .reverse()
      .find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    const cycleSummary = agentMeta.status_report ||
      agentMeta.response ||
      (lastAssistant?.content!)?.slice(0, 500) ||
      '';

    state.metadata.heartbeatLastCycleSummary = cycleSummary;
    state.metadata.currentFocus = agentMeta.currentFocus || state.metadata.currentFocus || '';

    // Map agent status to heartbeat status
    if (agentStatus === 'done') {
      state.metadata.heartbeatStatus = 'done';
    } else if (agentStatus === 'blocked') {
      // Sub-agent is blocked — inject the blocker context into the heartbeat
      // conversation so the orchestrator can decide what to do next cycle
      const blockerReason = agentMeta.blocker_reason || 'Unknown blocker';
      const unblockReqs = agentMeta.unblock_requirements || '';
      console.log(`[HeartbeatNode] Sub-agent blocked — reason: ${ blockerReason }, requirements: ${ unblockReqs }`);

      state.messages.push({
        role:    'system',
        content: [
          `[Sub-agent blocked]`,
          `Blocker: ${ blockerReason }`,
          unblockReqs ? `Requirements to unblock: ${ unblockReqs }` : '',
          `Decide whether to resolve this yourself, escalate to the user via send_channel_message, or move on to other work.`,
        ].filter(Boolean).join('\n'),
      } as ChatMessage);

      // Don't end the heartbeat — let it continue to the next cycle
      // so the orchestrator can act on the blocker
      state.metadata.heartbeatStatus = 'running';
    } else {
      state.metadata.heartbeatStatus = 'running';
    }

    const elapsed = Date.now() - cycleStart;
    console.log(`[HeartbeatNode] Cycle ${ cycleNum } complete — status: ${ agentStatus }, elapsed: ${ elapsed }ms`);

    return { state, decision: { type: 'next' } };
  }

  // ======================================================================
  // CONTEXT LOADERS
  // ======================================================================

  private async loadActiveProjects(): Promise<string> {
    try {
      const { projectRegistry } = await import('../database/registry/ProjectRegistry');
      const summaries = await projectRegistry.listProjects();

      if (!summaries || summaries.length === 0) {
        return 'No active projects found. Create a project by using create_workspace then writing a PROJECT.md in the folder.';
      }

      const lines = summaries.map(p =>
        `- **${ p.name }** (slug: \`${ p.slug }\`, status: ${ p.status }): ${ p.description }`,
      );
      return `## Active Projects\n${ lines.join('\n') }`;
    } catch (err) {
      console.warn('[HeartbeatNode] Failed to load projects:', err);
      return 'Unable to load projects — use meta_search to discover them or browse the projects directory.';
    }
  }

  private async loadAvailableSkills(): Promise<string> {
    try {
      const { skillsRegistry } = await import('../database/registry/SkillsRegistry');
      const summaries = await skillsRegistry.getSkillSummaries();

      if (!summaries || summaries.length === 0) {
        return 'No skills found yet. Create skills by writing SKILL.md files in the skills directory.';
      }

      const lines = summaries.map(s =>
        `- **${ s.name }** (slug: \`${ s.slug }\`): ${ s.description }`,
      );
      return `## Available Skills\n${ lines.join('\n') }`;
    } catch (err) {
      console.warn('[HeartbeatNode] Failed to load skills:', err);
      return 'Unable to load skills — use meta_search tool to discover them.';
    }
  }

  // ======================================================================
  // HUMAN-HEARTBEAT BRIDGE LOADERS
  // ======================================================================

  private async loadActiveAgentsContext(): Promise<string> {
    try {
      const { getActiveAgentsRegistry } = await import('../services/ActiveAgentsRegistry');
      const registry = getActiveAgentsRegistry();
      return await registry.buildContextBlock();
    } catch (err) {
      console.warn('[HeartbeatNode] Failed to load active agents context:', err);
      return '';
    }
  }

  // ======================================================================
  // PROMPT BUILDER
  // ======================================================================

  private buildAutonomousPrompt(state: HeartbeatThreadState): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toLocaleString('en-US', {
      timeZone: tz,
      weekday:  'long',
      year:     'numeric',
      month:    'long',
      day:      'numeric',
      hour:     '2-digit',
      minute:   '2-digit',
      hour12:   true,
    });

    const cycleNum = state.metadata.heartbeatCycleCount || 1;
    const maxCycles = state.metadata.heartbeatMaxCycles || MAX_HEARTBEAT_CYCLES;
    const priorSummary = state.metadata.heartbeatLastCycleSummary || '';
    const currentFocus = state.metadata.currentFocus || '';

    const parts: string[] = [];

    // Core heartbeat directive
    parts.push(heartbeatPrompt);

    // Time context
    parts.push(`\n---\n## Current Context\n`);
    parts.push(`**Time:** ${ timeStr } (${ tz })`);
    parts.push(`**Heartbeat Cycle:** ${ cycleNum } of ${ maxCycles }`);

    // Projects
    parts.push(`\n${ state.metadata.activeProjects }`);

    // Skills
    parts.push(`\n${ state.metadata.availableSkills }`);

    // Active agents, channels, and human presence (injected every cycle)
    if (state.metadata.agentsContext) {
      parts.push(`\n${ state.metadata.agentsContext }`);
    }

    // Continuity from prior cycle
    if (priorSummary && cycleNum > 1) {
      parts.push(`\n## Prior Cycle Summary\n${ priorSummary }`);
    }
    if (currentFocus) {
      parts.push(`\n## Current Focus\n${ currentFocus }`);
    }

    // Autonomous directives
    parts.push(`\n---\n## Autonomous Execution Rules

You are running autonomously — no human is watching. Act decisively.

1. **Respond to incoming messages FIRST.** If there are user messages in this thread (after the autonomous prompt), read them and reply using **send_channel_message** to the sender's channel. This is non-negotiable — never ignore someone talking to you.
2. **Pick the highest-impact work.** If no incoming messages, review active projects and pick the one where you can make the most progress right now. If no projects exist, create one based on your mission.
3. **Use your tools.** You have full access to: file system, Docker, n8n, git, memory, calendar, playwright, skills, projects, and the **bridge** tools. Use them.
4. **Communicate via channels.** To reach the human or another agent, use **send_channel_message** with the target channel from the Active Agents list above. Include your sender_id and sender_channel so they can reply.
5. **Learn and create skills.** If you find yourself doing something that could be reusable, create a skill for it using create_skill. If a skill exists for what you need, load and follow it.
6. **Track your work.** Update project PRDs with progress. Add observational memories for important findings. Update project status when milestones are hit.
7. **Be concrete.** Don't just plan — execute. Write code, create files, run commands, build automations, deploy things.
8. **Know when to stop.** If you've accomplished meaningful work or hit a blocker that requires human input, use the DONE or BLOCKED wrapper.

If this is your first heartbeat and no projects exist, your first task should be to review any existing skills and memory, then create a project for whatever will deliver the most value.`);

    return parts.join('\n');
  }

  // ======================================================================
  // AGENT STATE BUILDER
  // ======================================================================

  private buildAgentState(parentState: HeartbeatThreadState, prompt: string): AgentGraphState {
    const now = Date.now();
    const threadId = `heartbeat_agent_${ now }_${ parentState.metadata.heartbeatCycleCount }`;

    return {
      messages: [
        {
          role:     'user',
          content:  prompt,
          metadata: {
            source: 'heartbeat',
            type:   'autonomous_prompt',
          },
        } as ChatMessage,
        // Include parent state messages so the agent sees incoming channel messages
        ...parentState.messages,
      ],
      metadata: {
        action:    'use_tools',
        threadId,
        wsChannel: parentState.metadata.wsChannel || HEARTBEAT_WS_CHANNEL,

        cycleComplete:  false,
        waitingForUser: false,
        isSubAgent:     true,

        llmModel: parentState.metadata.llmModel,
        llmLocal: parentState.metadata.llmLocal,
        options:  parentState.metadata.options || {},

        currentNodeId:        'input_handler',
        consecutiveSameNode:  0,
        iterations:           0,
        revisionCount:        0,
        maxIterationsReached: false,

        memory: {
          knowledgeBaseContext: '',
          chatSummariesContext: '',
        },
        subGraph: {
          state:    'completed',
          name:     'hierarchical',
          prompt:   '',
          response: '',
        },
        finalSummary:         '',
        finalState:           'running',
        n8nLiveEventsEnabled: parentState.metadata.n8nLiveEventsEnabled || false,
        returnTo:             null,

        agent:          undefined,
        agentLoopCount: 0,
      },
    };
  }
}
