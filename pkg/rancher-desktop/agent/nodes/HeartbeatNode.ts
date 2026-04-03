// HeartbeatNode.ts
// Scans production workflows for heartbeat trigger nodes and executes them.
// Each heartbeat cycle picks the next pending workflow, spawns a sub-agent
// that calls execute_workflow, and captures the outcome. The heartbeat graph
// loops until all workflows are done or max cycles are hit.

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import { BaseNode } from './BaseNode';
import type { BaseThreadState, NodeResult, AgentGraphState } from './Graph';
import type { ChatMessage } from '../languagemodels/BaseLanguageModel';

// ============================================================================
// HEARTBEAT THREAD STATE
// ============================================================================

export interface HeartbeatThreadState extends BaseThreadState {
  messages: ChatMessage[];
  metadata: BaseThreadState['metadata'] & {
    // Heartbeat tracking
    heartbeatCycleCount:       number;
    heartbeatMaxCycles:        number;
    heartbeatStatus:           'running' | 'done' | 'blocked' | 'idle';
    heartbeatLastCycleSummary: string;

    // Workflow execution tracking
    pendingWorkflows:   Array<{ id: string; name: string; description: string }>;
    completedWorkflows: string[];
    currentFocus:       string;

    // Environmental context
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
 * Heartbeat Node — Scans production workflows for heartbeat triggers and
 * executes them sequentially. Each cycle picks the next pending workflow,
 * spawns a fresh AgentGraph that calls execute_workflow, and captures the
 * outcome. Exits when all workflows are done or max cycles reached.
 */
export class HeartbeatNode extends BaseNode {
  constructor() {
    super('heartbeat', 'Heartbeat');
  }

  async execute(state: HeartbeatThreadState): Promise<NodeResult<HeartbeatThreadState>> {
    const cycleStart = Date.now();
    const cycleNum = (state.metadata.heartbeatCycleCount || 0) + 1;
    state.metadata.heartbeatCycleCount = cycleNum;

    const maxCycles = state.metadata.heartbeatMaxCycles || MAX_HEARTBEAT_CYCLES;
    console.log(`[HeartbeatNode] ═══ Cycle ${ cycleNum }/${ maxCycles } ═══`);

    // Check abort signal before starting cycle
    const abortSignal = (state.metadata as any).abortSignal as AbortSignal | undefined;
    if (abortSignal?.aborted) {
      console.log('[HeartbeatNode] Abort signal received — exiting');
      state.metadata.heartbeatStatus = 'done';
      return { state, decision: { type: 'end' } };
    }

    // ----------------------------------------------------------------
    // 1. SCAN FOR HEARTBEAT WORKFLOWS (first cycle only)
    // ----------------------------------------------------------------
    if (cycleNum === 1) {
      state.metadata.pendingWorkflows = this.scanHeartbeatWorkflows();
      state.metadata.completedWorkflows = [];

      if (state.metadata.pendingWorkflows.length === 0) {
        console.log('[HeartbeatNode] No workflows with heartbeat triggers found — done');
        state.metadata.heartbeatStatus = 'done';
        state.metadata.heartbeatLastCycleSummary = 'No heartbeat-triggered workflows found.';
        return { state, decision: { type: 'end' } };
      }

      console.log(`[HeartbeatNode] Found ${ state.metadata.pendingWorkflows.length } heartbeat workflow(s): ${ state.metadata.pendingWorkflows.map(w => w.name).join(', ') }`);
    }

    // ----------------------------------------------------------------
    // 2. PICK NEXT PENDING WORKFLOW
    // ----------------------------------------------------------------
    const nextWorkflow = state.metadata.pendingWorkflows.shift();
    if (!nextWorkflow) {
      console.log('[HeartbeatNode] All heartbeat workflows completed — done');
      state.metadata.heartbeatStatus = 'done';
      state.metadata.heartbeatLastCycleSummary = `Completed ${ state.metadata.completedWorkflows.length } workflow(s): ${ state.metadata.completedWorkflows.join(', ') }`;
      return { state, decision: { type: 'end' } };
    }

    state.metadata.currentFocus = nextWorkflow.name;
    console.log(`[HeartbeatNode] Executing workflow: "${ nextWorkflow.name }" (${ nextWorkflow.id })`);

    // ----------------------------------------------------------------
    // 3. LOAD AGENTS CONTEXT (fresh each cycle)
    // ----------------------------------------------------------------
    state.metadata.agentsContext = await this.loadActiveAgentsContext();

    // ----------------------------------------------------------------
    // 4. BUILD WORKFLOW EXECUTION PROMPT
    // ----------------------------------------------------------------
    const prompt = this.buildWorkflowPrompt(nextWorkflow, state);

    // ----------------------------------------------------------------
    // 5. SPAWN AGENT GRAPH to execute the workflow
    // ----------------------------------------------------------------
    const { createAgentGraph } = await import('./Graph');
    const agentGraph = createAgentGraph();
    const agentState = this.buildAgentState(state, prompt);

    console.log(`[HeartbeatNode] Spawning AgentGraph for workflow "${ nextWorkflow.name }" (threadId=${ agentState.metadata.threadId })`);

    try {
      await agentGraph.execute(agentState, 'input_handler');
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        console.log('[HeartbeatNode] AgentGraph aborted');
        state.metadata.heartbeatStatus = 'done';
        return { state, decision: { type: 'end' } };
      }
      console.error(`[HeartbeatNode] Workflow "${ nextWorkflow.name }" execution error:`, err);
    } finally {
      await agentGraph.destroy();
    }

    // ----------------------------------------------------------------
    // 6. CAPTURE OUTCOME
    // ----------------------------------------------------------------
    const agentMeta = (agentState.metadata as any).agent || {};
    const agentStatus = String(agentMeta.status || 'done').toLowerCase();
    const workflowMeta = (agentState.metadata as any).activeWorkflow;
    const workflowStatus = workflowMeta?.status || 'unknown';

    const lastAssistant = [...agentState.messages]
      .reverse()
      .find(m => m.role === 'assistant' && typeof m.content === 'string' && m.content.trim());
    const cycleSummary = agentMeta.status_report ||
      (lastAssistant?.content!)?.slice(0, 500) ||
      `Workflow "${ nextWorkflow.name }" finished with status: ${ workflowStatus }`;

    state.metadata.heartbeatLastCycleSummary = cycleSummary;
    state.metadata.completedWorkflows.push(nextWorkflow.name);

    console.log(`[HeartbeatNode] Workflow "${ nextWorkflow.name }" complete — agent: ${ agentStatus }, workflow: ${ workflowStatus }`);

    // If more workflows remain, keep running
    if (state.metadata.pendingWorkflows.length > 0) {
      state.metadata.heartbeatStatus = 'running';
    } else {
      state.metadata.heartbeatStatus = 'done';
    }

    const elapsed = Date.now() - cycleStart;
    console.log(`[HeartbeatNode] Cycle ${ cycleNum } complete — elapsed: ${ elapsed }ms, remaining workflows: ${ state.metadata.pendingWorkflows.length }`);

    return { state, decision: { type: 'next' } };
  }

  // ======================================================================
  // WORKFLOW SCANNER
  // ======================================================================

  private scanHeartbeatWorkflows(): Array<{ id: string; name: string; description: string }> {
    try {
      const { resolveAllWorkflowsProductionDirs } = require('@pkg/agent/utils/sullaPaths');
      const workflowsDirs: string[] = resolveAllWorkflowsProductionDirs();
      const results: Array<{ id: string; name: string; description: string }> = [];

      for (const workflowsDir of workflowsDirs) {
        if (!fs.existsSync(workflowsDir)) {
          console.log(`[HeartbeatNode] No workflows dir: ${ workflowsDir }`);
          continue;
        }

        const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile() || !(entry.name.endsWith('.yaml') || entry.name.endsWith('.json'))) continue;

          try {
            const filePath = path.join(workflowsDir, entry.name);
            const raw = fs.readFileSync(filePath, 'utf-8');
            const definition = entry.name.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);

            if (!definition.enabled) continue;

            const hasHeartbeatTrigger = (definition.nodes || []).some(
              (node: any) => node.data?.category === 'trigger' && node.data?.subtype === 'heartbeat',
            );

            if (hasHeartbeatTrigger) {
              results.push({
                id:          definition.id || entry.name.replace(/\.(yaml|json)$/, ''),
                name:        definition.name || entry.name,
                description: definition.description || '',
              });
            }
          } catch (err) {
            console.warn(`[HeartbeatNode] Failed to parse workflow ${ entry.name }:`, err);
          }
        }
      }

      return results;
    } catch (err) {
      console.error('[HeartbeatNode] Failed to scan workflows:', err);
      return [];
    }
  }

  // ======================================================================
  // PROMPT BUILDER
  // ======================================================================

  private buildWorkflowPrompt(
    workflow: { id: string; name: string; description: string },
    state: HeartbeatThreadState,
  ): string {
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

    const parts: string[] = [];

    parts.push(`# Heartbeat — Execute Workflow`);
    parts.push(``);
    parts.push(`A heartbeat trigger has fired. Execute the following workflow now.`);
    parts.push(``);
    parts.push(`## Workflow Details`);
    parts.push(`- **Name:** ${ workflow.name }`);
    parts.push(`- **ID:** ${ workflow.id }`);
    if (workflow.description) {
      parts.push(`- **Description:** ${ workflow.description }`);
    }
    parts.push(`- **Triggered at:** ${ timeStr } (${ tz })`);
    parts.push(``);
    parts.push(`## Instructions`);
    parts.push(``);
    parts.push(`Use the \`execute_workflow\` tool to run this workflow:`);
    parts.push(`- workflowId: "${ workflow.id }"`);
    parts.push(``);
    parts.push(`After calling execute_workflow, the workflow playbook will take over and orchestrate all the workflow nodes. Follow the playbook's instructions for each node.`);

    // Inter-agent context
    if (state.metadata.agentsContext) {
      parts.push(``);
      parts.push(state.metadata.agentsContext);
    }

    return parts.join('\n');
  }

  // ======================================================================
  // CONTEXT LOADERS
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
  // AGENT STATE BUILDER
  // ======================================================================

  private buildAgentState(parentState: HeartbeatThreadState, prompt: string): AgentGraphState {
    const now = Date.now();
    const threadId = `heartbeat_wf_${ now }_${ parentState.metadata.heartbeatCycleCount }`;

    return {
      messages: [
        {
          role:     'user',
          content:  prompt,
          metadata: {
            source: 'heartbeat',
            type:   'workflow_trigger',
          },
        } as ChatMessage,
      ],
      metadata: {
        action:    'use_tools',
        threadId,
        wsChannel: parentState.metadata.wsChannel || HEARTBEAT_WS_CHANNEL,

        cycleComplete:  false,
        waitingForUser: false,
        isSubAgent:     true,
        subAgentDepth:  0,

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
