/**
 * PlaybookController — workflow/playbook orchestration extracted from Graph.ts.
 *
 * Coordinates the walker loop that processes workflow DAG nodes:
 * prompt_orchestrator, spawn_sub_agent, spawn_parallel_agents, etc.
 *
 * Holds all pending sub-agent state (completions, failures, escalations)
 * and emits WebSocket events for the canvas and chat UI.
 *
 * Delegates back to Graph.execute() when the agent loop needs to re-enter
 * (e.g. for decision prompts, workflow completion summaries).
 */

import * as fsSync from 'fs';
import * as osUtil from 'os';
import * as pathUtil from 'path';

import { throwIfAborted } from '../services/AbortService';
import { getConversationLogger } from '../services/ConversationLogger';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import {
  processNextStep,
  resolveDecision,
  completeSubAgent,
  createPlaybookState,
  type PlaybookStepResult,
} from '../workflow/WorkflowPlaybook';

import type { WorkflowPlaybookState, PlaybookNodeOutput } from '../workflow/types';

// ============================================================================
// PLAYBOOK DEBUG LOGGER
// ============================================================================

const PLAYBOOK_LOG_PATH = pathUtil.join(osUtil.homedir(), 'sulla', 'logs', 'playbook-debug.log');

function playbookLog(tag: string, data: Record<string, unknown> = {}): void {
  try {
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, tag, ...data });
    fsSync.appendFileSync(PLAYBOOK_LOG_PATH, line + '\n');
  } catch {
    // swallow — logging must never break execution
  }
}

// ============================================================================
// HELPER TYPES & FUNCTIONS
// ============================================================================

interface ParsedHandBack {
  summary:        string;
  artifact:       string;
  needsUserInput: boolean;
  rawOutput:      string;
}

function parseHandBack(output: string): ParsedHandBack {
  const raw = typeof output === 'string' ? output : JSON.stringify(output);
  const agentDoneMatch = /<AGENT_DONE>([\s\S]*?)<\/AGENT_DONE>/i.exec(raw);

  if (!agentDoneMatch) {
    return {
      summary:        raw.substring(0, 500),
      artifact:       'none',
      needsUserInput: false,
      rawOutput:      raw,
    };
  }

  const doneBlock = agentDoneMatch[1].trim();
  const needsInputMatch = /Needs user input:\s*(yes|no)/i.exec(doneBlock);
  const needsUserInput = needsInputMatch ? /^yes$/i.test(needsInputMatch[1]) : false;
  const summary = doneBlock
    .replace(/Needs user input:\s*(yes|no)/i, '')
    .trim()
    .substring(0, 500) || '';

  return {
    summary,
    artifact:       'none',
    needsUserInput,
    rawOutput:      raw,
  };
}

interface ParsedPrompt {
  agentId: string | null;
  label:   string | null;
  content: string;
}

function parsePromptTags(text: string): ParsedPrompt[] {
  const tagRegex = /<PROMPT([^>]*)>([\s\S]*?)<\/PROMPT>/gi;
  const prompts: ParsedPrompt[] = [];
  let match;

  while ((match = tagRegex.exec(text)) !== null) {
    const attrs = match[1] || '';
    const content = (match[2] || '').trim();
    const agentIdMatch = /agentId="([^"]*)"/.exec(attrs);
    const labelMatch = /label="([^"]*)"/.exec(attrs);

    if (content) {
      prompts.push({
        agentId: agentIdMatch?.[1] || null,
        label:   labelMatch?.[1] || null,
        content,
      });
    }
  }

  return prompts;
}

// ============================================================================
// GRAPH INTERFACE
// ============================================================================

/**
 * Minimal interface that PlaybookController needs from Graph.
 * Avoids circular imports by not importing Graph directly.
 */
export interface PlaybookGraphInterface<TState> {
  execute(state: TState, entryPointNodeId?: string, options?: { maxIterations: number; _isPlaybookReentry?: boolean }): Promise<TState>;
  getEntryPoint(): string | null;
  getNode(nodeId: string): any;
}

// ============================================================================
// PLAYBOOK CONTROLLER
// ============================================================================

export class PlaybookController<TState = any> {
  private readonly graph: PlaybookGraphInterface<TState>;

  // ── Sub-agent tracking state ──
  private pendingSubAgents = new Map<string, {
    nodeId:    string;
    nodeLabel: string;
    agentId:   string;
    startedAt: number;
  }>();

  private pendingCompletions: {
    nodeId:    string;
    nodeLabel: string;
    output:    unknown;
    threadId?: string;
  }[] = [];

  private pendingFailures: {
    nodeId:    string;
    nodeLabel: string;
    error:     string;
  }[] = [];

  private pendingEscalations: {
    nodeId:                 string;
    nodeLabel:              string;
    agentId:                string;
    prompt:                 string;
    config:                 Record<string, unknown>;
    question:               string;
    threadId?:              string;
    orchestratorAttempted?: boolean;
  }[] = [];

  private isProcessingPlaybook = false;
  private _continuationQueued = false;

  constructor(graph: PlaybookGraphInterface<TState>) {
    this.graph = graph;
  }

  // ─── Public API ─────────────────────────────────────────────────

  async processWorkflowPlaybook(state: TState): Promise<TState> {
    this.isProcessingPlaybook = true;
    try {
      return await this._processWorkflowPlaybookInner(state);
    } finally {
      this.isProcessingPlaybook = false;

      if (this._continuationQueued) {
        this._continuationQueued = false;
        const hasUndrained = this.pendingCompletions.length > 0 || this.pendingFailures.length > 0 || this.pendingEscalations.length > 0;
        if (hasUndrained) {
          console.log('[PlaybookController] Draining queued continuation after processWorkflowPlaybook unlock');
          setImmediate(async() => {
            try {
              await this.processWorkflowPlaybook(state);
            } catch (err) {
              console.error('[PlaybookController] Queued continuation failed:', err);
            }
          });
        }
      }
    }
  }

  // ─── Inner Walker ───────────────────────────────────────────────

  private async _processWorkflowPlaybookInner(state: TState): Promise<TState> {
    const meta = (state as any).metadata;
    const playbook: WorkflowPlaybookState | undefined = meta?.activeWorkflow;

    console.log(`[PlaybookController] processWorkflowPlaybook called — status=${ playbook?.status }, frontier=[${ playbook?.currentNodeIds?.join(', ') || '' }], completed=${ playbook?.completedNodeIds?.length ?? 0 }, defNodes=${ playbook?.definition?.nodes?.length ?? 0 }, defEdges=${ playbook?.definition?.edges?.length ?? 0 }`);

    if (playbook?.status !== 'running') {
      console.log(`[PlaybookController] Skipping — playbook status is '${ playbook?.status }', not 'running'`);
      return state;
    }

    // ── Drain persisted completions/failures/escalations from DB ──
    try {
      const { WorkflowPendingCompletionModel } = await import('../database/models/WorkflowPendingCompletionModel');
      const persistedRecords = await WorkflowPendingCompletionModel.findPending(playbook.executionId);

      for (const record of persistedRecords) {
        const attrs = record.attributes;
        const alreadyInMemory = (kind: string) => {
          if (kind === 'completion') return this.pendingCompletions.some(c => c.nodeId === attrs.node_id);
          if (kind === 'failure') return this.pendingFailures.some(f => f.nodeId === attrs.node_id);
          if (kind === 'escalation') return this.pendingEscalations.some(e => e.nodeId === attrs.node_id);
          return false;
        };

        const alreadyCompleted = playbook.completedNodeIds.includes(attrs.node_id!);

        if (!alreadyInMemory(attrs.kind!) && !alreadyCompleted) {
          if (attrs.kind === 'completion') {
            this.pendingCompletions.push({ nodeId: attrs.node_id!, nodeLabel: attrs.node_label!, output: attrs.output, threadId: attrs.thread_id ?? undefined });
            console.log(`[PlaybookController] Restored persisted completion for "${ attrs.node_label }" from DB`);
          } else if (attrs.kind === 'failure') {
            this.pendingFailures.push({ nodeId: attrs.node_id!, nodeLabel: attrs.node_label!, error: attrs.error || 'Unknown error' });
            console.log(`[PlaybookController] Restored persisted failure for "${ attrs.node_label }" from DB`);
          } else if (attrs.kind === 'escalation' && attrs.escalation) {
            const esc = attrs.escalation as Record<string, any>;
            this.pendingEscalations.push({
              nodeId:    attrs.node_id!,
              nodeLabel: attrs.node_label!,
              agentId:   esc.agentId || '',
              prompt:    esc.prompt || '',
              config:    esc.config || {},
              question:  esc.question || '',
              threadId:  attrs.thread_id ?? undefined,
            });
            console.log(`[PlaybookController] Restored persisted escalation for "${ attrs.node_label }" from DB`);
          }
        }

        await WorkflowPendingCompletionModel.markDrained(attrs.id!);
      }
    } catch (err) {
      console.warn('[PlaybookController] Failed to drain persisted completions from DB:', err);
    }

    // ── Reset canvas and replay completed nodes ──
    if (!(playbook as any)._workflowStartedEmitted) {
      this.emitPlaybookEvent(state, 'workflow_started', { workflowId: playbook.workflowId });
      (playbook as any)._workflowStartedEmitted = true;
    }

    for (const [nodeId, output] of Object.entries(playbook.nodeOutputs ?? {})) {
      this.emitPlaybookEvent(state, 'node_completed', {
        nodeId,
        nodeLabel: output.label,
        output:    output.result,
      });
      this.emitEdgeActivations(state, playbook.definition, nodeId, 'outgoing');
    }

    // If there's a pending decision, resolve it
    if (playbook.pendingDecision) {
      const msgs = (state as any).messages;
      const pendingSubtype = playbook.pendingDecision.subtype;

      let resolveContent: string | undefined;

      if (pendingSubtype === 'user-input') {
        const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user' && !m.content?.startsWith?.('[Workflow]'));
        resolveContent = lastUser?.content ? String(lastUser.content) : undefined;
      } else {
        const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
        resolveContent = lastAssistant?.content ? String(lastAssistant.content) : undefined;
      }

      if (resolveContent) {
        const pendNodeId = playbook.pendingDecision.nodeId;
        const resolved = resolveDecision(playbook, resolveContent);
        meta.activeWorkflow = resolved.updatedPlaybook;

        const pendNodeLabel = this.getPlaybookNodeLabel(playbook, pendNodeId);
        const pendNodeSubtype = this.getPlaybookNodeSubtype(playbook, pendNodeId);
        this.emitPlaybookEvent(state, 'node_completed', {
          nodeId:    pendNodeId,
          nodeLabel: pendNodeLabel,
          output:    resolveContent,
        });
        this.emitEdgeActivations(state, playbook.definition, pendNodeId, 'outgoing');
        await this.saveCheckpoint(resolved.updatedPlaybook, pendNodeId, pendNodeLabel, pendNodeSubtype, resolveContent);

        if (resolved.action === 'workflow_completed' || resolved.action === 'workflow_failed') {
          this.emitPlaybookEvent(state, resolved.action, {});
          const outcome = resolved.action === 'workflow_completed' ? 'completed' : 'failed';
          state = await this.releaseWorkflow(state, resolved.updatedPlaybook, outcome);
          return state;
        }
      } else {
        return state;
      }
    }

    // ── Drain pending sub-agent completions ──
    while (this.pendingCompletions.length > 0) {
      const completion = this.pendingCompletions.shift()!;
      const pendingEntry = this.pendingSubAgents.get(completion.nodeId);
      this.pendingSubAgents.delete(completion.nodeId);
      const completionLabel = completion.nodeLabel;
      const resultText = typeof completion.output === 'string' ? completion.output : JSON.stringify(completion.output);

      console.log(`[PlaybookController] Draining pending completion for "${ completionLabel }" (node: ${ completion.nodeId })`);

      // Phase 3: Orchestrator evaluates with success criteria (single-agent)
      const pendingSuccessCriteria = (pendingEntry as any)?.successCriteria || '';
      let finalOutput = completion.output;

      const contractMatch = /<completion-contract>([\s\S]*?)<\/completion-contract>/.exec(resultText);
      const contractContent = contractMatch ? contractMatch[1].trim() : null;

      if (pendingSuccessCriteria.trim()) {
        const evalMsg = `[Sub-agent Complete: ${ completionLabel }]\n\n` +
          (contractContent
            ? `Completion contract response:\n${ contractContent }\n\nFull output:\n${ resultText }\n\n`
            : `Sub-agent output:\n${ resultText }\n\n`) +
          `Evaluate the sub-agent's response against the following success criteria:\n${ pendingSuccessCriteria }\n\n` +
          `If the response meets all criteria, respond with APPROVED and a brief summary of what was delivered.\n` +
          `If it fails any criteria, respond with NEEDS_REVISION and explain what fell short.`;

        this.injectWorkflowMessage(state, evalMsg);
        state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        const evalResponse = (state as any).messages?.[(state as any).messages.length - 1];
        const evalText = typeof evalResponse?.content === 'string' ? evalResponse.content : '';
        finalOutput = `${ resultText }\n\n[Orchestrator Evaluation]\n${ evalText }`;
      }

      const completed = completeSubAgent(meta.activeWorkflow, completion.nodeId, finalOutput, completion.threadId);
      meta.activeWorkflow = completed.updatedPlaybook;

      const finalResultText = typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput);
      this.emitPlaybookEvent(state, 'node_completed', { nodeId: completion.nodeId, nodeLabel: completionLabel, output: finalResultText, threadId: completion.threadId });
      this.emitEdgeActivations(state, meta.activeWorkflow.definition, completion.nodeId, 'outgoing');
      await this.saveCheckpoint(completed.updatedPlaybook, completion.nodeId, completionLabel, 'agent', finalResultText);

      if (!pendingSuccessCriteria.trim()) {
        const handBack = parseHandBack(resultText);
        const resultMsg = `[Workflow Node Complete: ${ completionLabel }]\nSummary: ${ handBack.summary }\nNeeds user input: ${ handBack.needsUserInput ? 'yes' : 'no' }`;
        this.injectWorkflowMessage(state, resultMsg, !handBack.needsUserInput);
      }

      const handBack = parseHandBack(resultText);

      if (handBack.needsUserInput) {
        console.log(`[PlaybookController] Node "${ completionLabel }" needs user input — pausing workflow`);
        this.emitPlaybookEvent(state, 'workflow_paused', { nodeId: completion.nodeId, nodeLabel: completionLabel, reason: 'needs_user_input', summary: handBack.summary });

        if (this.pendingCompletions.length > 0) {
          const execId = meta.activeWorkflow?.executionId;
          if (execId) {
            try {
              const { WorkflowPendingCompletionModel } = await import('../database/models/WorkflowPendingCompletionModel');
              for (const remaining of this.pendingCompletions) {
                await WorkflowPendingCompletionModel.saveCompletion({ executionId: execId, nodeId: remaining.nodeId, nodeLabel: remaining.nodeLabel, output: remaining.output, threadId: remaining.threadId });
              }
              console.log(`[PlaybookController] Persisted ${ this.pendingCompletions.length } undrained completions before needsUserInput pause`);
            } catch (e) { console.warn('[PlaybookController] Failed to persist undrained completions:', e) }
          }
        }

        const pauseMsg = `[Workflow Paused: "${ completionLabel }" needs user input]\n` +
          `${ handBack.summary }\n\n` +
          `The workflow is paused. Tell the user what the agent needs and wait for their response.`;
        this.injectWorkflowMessage(state, pauseMsg);
        state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        (state as any).metadata.waitingForUser = true;
        return state;
      }

      if (completed.action === 'workflow_completed') {
        this.emitPlaybookEvent(state, 'workflow_completed', {});
        state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
        return state;
      }
    }

    // ── Drain pending sub-agent failures ──
    while (this.pendingFailures.length > 0) {
      const failure = this.pendingFailures.shift()!;
      this.pendingSubAgents.delete(failure.nodeId);

      console.error(`[PlaybookController] Draining pending failure for "${ failure.nodeLabel }" (node: ${ failure.nodeId }): ${ failure.error }`);

      this.emitPlaybookEvent(state, 'node_failed', { nodeId: failure.nodeId, nodeLabel: failure.nodeLabel, error: failure.error });

      const escalationMsg = `[Workflow Node Failed: ${ failure.nodeLabel }]\n` +
        `The sub-agent "${ failure.nodeLabel }" failed.\n` +
        `Error: ${ failure.error }\n\n` +
        `If this failure is unrecoverable and the workflow cannot continue, you may abort it by responding with:\n` +
        `<ABORT_WORKFLOW>Reason the workflow cannot continue</ABORT_WORKFLOW>\n\n` +
        `Otherwise, tell the user what happened and ask what they'd like to do.`;
      this.injectWorkflowMessage(state, escalationMsg);
    }

    // ── Drain pending sub-agent escalations ──
    if (this.pendingEscalations.length > 0) {
      const esc = this.pendingEscalations[0];
      const msgs = (state as any).messages;

      if (!esc.orchestratorAttempted) {
        console.log(`[PlaybookController] Sub-agent "${ esc.nodeLabel }" blocked — asking orchestrator to answer: ${ esc.question.slice(0, 200) }`);

        esc.orchestratorAttempted = true;

        const orchestratorPrompt =
          `[Workflow: Sub-agent "${ esc.nodeLabel }" has a question]\n` +
          `The sub-agent is blocked and needs an answer before it can continue.\n\n` +
          `Sub-agent's question:\n${ esc.question }\n\n` +
          `You are the orchestrator. Based on the workflow context and conversation history, ` +
          `decide if YOU can answer this question or if it must go to the user.\n\n` +
          `Respond with exactly ONE of these XML blocks:\n\n` +
          `If you CAN answer:\n` +
          `<SUB_AGENT_ANSWER>Your answer here</SUB_AGENT_ANSWER>\n\n` +
          `If you CANNOT answer (needs human judgment, credentials, or info you don't have):\n` +
          `<SUB_AGENT_ESCALATE>Brief explanation of what the user needs to decide</SUB_AGENT_ESCALATE>\n\n` +
          `If the workflow is stuck and cannot continue (repeated failures, unrecoverable errors):\n` +
          `<ABORT_WORKFLOW>Reason the workflow cannot continue</ABORT_WORKFLOW>\n\n` +
          `Do NOT use send_notification_to_human — reply directly with one of the XML blocks above.`;

        this.injectWorkflowMessage(state, orchestratorPrompt);
        (state as any).metadata._muteWsChat = true;
        state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
        (state as any).metadata._muteWsChat = false;

        const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
        const response = lastAssistant?.content ? String(lastAssistant.content) : '';

        const abortEscState = await this.handleAbortIfSignalled(state, response);
        if (abortEscState) return abortEscState;

        const answerMatch = /<SUB_AGENT_ANSWER>([\s\S]*?)<\/SUB_AGENT_ANSWER>/i.exec(response);
        const escalateMatch = /<SUB_AGENT_ESCALATE>([\s\S]*?)<\/SUB_AGENT_ESCALATE>/i.exec(response);

        if (answerMatch && !escalateMatch) {
          const orchestratorAnswer = answerMatch[1].trim();
          this.pendingEscalations.shift();
          const augmentedPrompt = `${ esc.prompt }\n\n[The orchestrating agent provided the following answer to your question]\n${ orchestratorAnswer }`;
          const maxRetries = 3;

          console.log(`[PlaybookController] Orchestrator answered blocked agent "${ esc.nodeLabel }" — re-launching with answer: ${ orchestratorAnswer.slice(0, 200) }`);

          this.pendingSubAgents.set(esc.nodeId, {
            nodeId:    esc.nodeId,
            nodeLabel: esc.nodeLabel,
            agentId:   esc.agentId,
            startedAt: Date.now(),
          });

          this.executeSubAgentWithRetry(state, esc.nodeId, esc.agentId, augmentedPrompt, esc.config, esc.nodeLabel, maxRetries);
          this.emitPlaybookEvent(state, 'node_started', { nodeId: esc.nodeId, nodeLabel: esc.nodeLabel, prompt: augmentedPrompt });

          const narrateMsg = `[Workflow: Answered sub-agent "${ esc.nodeLabel }"]\n` +
            `The sub-agent asked: ${ esc.question.slice(0, 300) }\n` +
            `I answered: ${ orchestratorAnswer.slice(0, 300) }\n\n` +
            `The sub-agent has been re-launched and is continuing its work.`;
          this.injectWorkflowMessage(state, narrateMsg);
          state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          return state;
        }

        console.log(`[PlaybookController] Orchestrator escalated blocked agent "${ esc.nodeLabel }" to user`);
      }

      // Phase 2: Escalate to user
      const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user' && !m.content?.startsWith?.('[Workflow'));
      const lastPauseMsg = [...msgs].reverse().find((m: any) =>
        typeof m.content === 'string' && m.content.includes('[Workflow Paused:') && m.content.includes(esc.nodeLabel));

      const lastUserIdx = lastUser ? msgs.indexOf(lastUser) : -1;
      const lastPauseIdx = lastPauseMsg ? msgs.indexOf(lastPauseMsg) : -1;

      if (lastUserIdx > lastPauseIdx && lastPauseIdx >= 0) {
        this.pendingEscalations.shift();
        const userAnswer = String(lastUser.content);
        const augmentedPrompt = `${ esc.prompt }\n\n[User provided the following input]\n${ userAnswer }`;
        const maxRetries = 3;

        console.log(`[PlaybookController] User responded to blocked agent "${ esc.nodeLabel }" — re-launching with user's answer`);

        this.pendingSubAgents.set(esc.nodeId, {
          nodeId:    esc.nodeId,
          nodeLabel: esc.nodeLabel,
          agentId:   esc.agentId,
          startedAt: Date.now(),
        });

        this.executeSubAgentWithRetry(state, esc.nodeId, esc.agentId, augmentedPrompt, esc.config, esc.nodeLabel, maxRetries);
        this.emitPlaybookEvent(state, 'node_started', { nodeId: esc.nodeId, nodeLabel: esc.nodeLabel, prompt: augmentedPrompt });
      } else {
        console.log(`[PlaybookController] Sub-agent "${ esc.nodeLabel }" blocked — pausing workflow for user input: ${ esc.question.slice(0, 200) }`);

        this.emitPlaybookEvent(state, 'workflow_paused', {
          nodeId:    esc.nodeId,
          nodeLabel: esc.nodeLabel,
          reason:    'agent_blocked',
          summary:   esc.question.slice(0, 500),
        });

        const pauseMsg = `[Workflow Paused: Sub-agent "${ esc.nodeLabel }" is blocked and needs user input]\n` +
          `${ esc.question }\n\n` +
          `The orchestrator could not answer this question. Tell the user what the agent needs. The workflow is paused until the user responds.`;

        this.injectWorkflowMessage(state, pauseMsg);
        state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

        (state as any).metadata.waitingForUser = true;
        return state;
      }
    }

    // ── Inject pending sub-agent status ──
    if (this.pendingSubAgents.size > 0) {
      const now = Date.now();
      const lines = [...this.pendingSubAgents.values()].map(sa => {
        const elapsed = Math.round((now - sa.startedAt) / 1000);
        const mins = Math.floor(elapsed / 60);
        const secs = elapsed % 60;
        const duration = mins > 0 ? `${ mins }m ${ secs }s` : `${ secs }s`;
        return `- "${ sa.nodeLabel }" (node: ${ sa.nodeId }) — running for ${ duration }`;
      });

      const statusBlock = `[Active Workflow Sub-Agents]\n${ lines.join('\n') }\n\n` +
        `These agents are working in the background as part of the active workflow.\n` +
        `Do not duplicate their work. You can tell the user about their progress or help with other things.\n\n` +
        `If the workflow is stuck in an unrecoverable state, you may abort it by responding with:\n` +
        `<ABORT_WORKFLOW>Reason the workflow cannot continue</ABORT_WORKFLOW>`;
      this.injectWorkflowMessage(state, statusBlock, true);
    }

    // Process steps until we need the agent or workflow completes
    console.log(`[PlaybookController] Entering walker loop`);
    playbookLog('walker_loop_enter', {
      playbookStatus: meta.activeWorkflow?.status,
      workflowSlug:   meta.activeWorkflow?.definition?.id,
      cycleComplete:  (state as any).metadata.cycleComplete,
      waitingForUser: (state as any).metadata.waitingForUser,
    });
    const continueProcessing = true;
    try {
      while (continueProcessing) {
        const currentPlaybook: WorkflowPlaybookState = meta.activeWorkflow;
        if (currentPlaybook?.status !== 'running') {
          playbookLog('walker_loop_break', { reason: 'playbook_not_running', status: currentPlaybook?.status });
          break;
        }

        const step: PlaybookStepResult = processNextStep(currentPlaybook);
        meta.activeWorkflow = step.updatedPlaybook;

        playbookLog('walker_step', {
          action:         step.action,
          nodeId:         (step as any).nodeId || 'n/a',
          playbookStatus: step.updatedPlaybook?.status,
          prompt:         (step as any).prompt ? String((step as any).prompt).slice(0, 200) : undefined,
        });
        console.log(`[PlaybookController] Step action=${ step.action }, nodeId=${ (step as any).nodeId || 'n/a' }, playbookStatus=${ step.updatedPlaybook?.status }`);

        switch (step.action) {
        case 'prompt_orchestrator': {
          const opNodeId = step.nodeId;
          const opLabel = this.getPlaybookNodeLabel(currentPlaybook, opNodeId);

          playbookLog('orchestrator_prompt_start', {
            nodeId:         opNodeId,
            label:          opLabel,
            promptLength:   step.prompt?.length,
            promptPreview:  String(step.prompt).slice(0, 200),
            cycleComplete:  (state as any).metadata.cycleComplete,
            waitingForUser: (state as any).metadata.waitingForUser,
            iterations:     (state as any).metadata.iterations,
            messageCount:   (state as any).messages?.length,
          });

          this.emitEdgeActivations(state, currentPlaybook.definition, opNodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: opNodeId, nodeLabel: opLabel, prompt: step.prompt });

          this.injectWorkflowMessage(state, step.prompt);

          // Scope workflowNodeId to this orchestrator step so BaseNode.wsChatMessage
          // emits node_thinking events attributed to this node. Without this, the
          // orchestrator's streaming reasoning never reaches the Live stream.
          const opPrevNodeId = (state as any).metadata?.workflowNodeId;
          const opPrevParentChannel = (state as any).metadata?.workflowParentChannel;
          (state as any).metadata.workflowNodeId = opNodeId;
          (state as any).metadata.workflowParentChannel = (state as any).metadata?.wsChannel || 'workbench';

          try {
            state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          } finally {
            (state as any).metadata.workflowNodeId = opPrevNodeId;
            (state as any).metadata.workflowParentChannel = opPrevParentChannel;
          }

          let opMsgs = (state as any).messages;
          let opLastAssistant = [...opMsgs].reverse().find((m: any) => m.role === 'assistant');
          let opResult: string | any = opLastAssistant?.content ?? '';

          playbookLog('orchestrator_prompt_raw_response', {
            nodeId:        opNodeId,
            label:         opLabel,
            resultType:    typeof opResult,
            isArray:       Array.isArray(opResult),
            contentBlocks: Array.isArray(opResult) ? opResult.map((b: any) => ({ type: b.type, textLen: b.type === 'text' ? b.text?.length : undefined })) : undefined,
            stringLen:     typeof opResult === 'string' ? opResult.length : undefined,
            cycleComplete: (state as any).metadata.cycleComplete,
            iterations:    (state as any).metadata.iterations,
            messageCount:  (state as any).messages?.length,
          });

          const isToolUseOnly = Array.isArray(opResult) &&
          opResult.length > 0 &&
          opResult.every((block: any) => block.type === 'tool_use');
          const opText = Array.isArray(opResult)
            ? opResult.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim()
            : String(opResult).trim();

          const abortState = await this.handleAbortIfSignalled(state, opText || String(opResult));
          if (abortState) return abortState;

          if (isToolUseOnly || opText.length < 10) {
            playbookLog('orchestrator_prompt_retry', {
              nodeId:      opNodeId,
              label:       opLabel,
              reason:      isToolUseOnly ? 'tool_use_only' : 'text_too_short',
              textLength:  opText.length,
              textPreview: opText.slice(0, 100),
            });
            console.warn(`[PlaybookController] Orchestrator prompt "${ opLabel }" exited without valid text output — re-prompting`);
            this.injectWorkflowMessage(state,
              `[Workflow: Missing Required Output — "${ opLabel }"]\n\n` +
            `You ended your turn without providing the text output that this workflow node requires. ` +
            `The downstream nodes cannot proceed without it.\n\n` +
            `Original instructions:\n${ step.prompt }\n\n` +
            `You MUST produce a substantive text response now. This is the output that will be ` +
            `passed to the next step in the workflow. Do not end your turn until you have provided it.`);

            const opRetryPrevNodeId = (state as any).metadata?.workflowNodeId;
            const opRetryPrevParentChannel = (state as any).metadata?.workflowParentChannel;
            (state as any).metadata.workflowNodeId = opNodeId;
            (state as any).metadata.workflowParentChannel = (state as any).metadata?.wsChannel || 'workbench';

            try {
              state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
            } finally {
              (state as any).metadata.workflowNodeId = opRetryPrevNodeId;
              (state as any).metadata.workflowParentChannel = opRetryPrevParentChannel;
            }

            opMsgs = (state as any).messages;
            opLastAssistant = [...opMsgs].reverse().find((m: any) => m.role === 'assistant');
            opResult = opLastAssistant?.content ?? '';

            playbookLog('orchestrator_prompt_retry_result', {
              nodeId:     opNodeId,
              label:      opLabel,
              resultType: typeof opResult,
              isArray:    Array.isArray(opResult),
              textLen:    Array.isArray(opResult)
                ? opResult.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').length
                : String(opResult).length,
            });
          }

          playbookLog('orchestrator_prompt_complete', {
            nodeId:        opNodeId,
            label:         opLabel,
            outputType:    typeof opResult,
            outputLength:  typeof opResult === 'string' ? opResult.length : JSON.stringify(opResult).length,
            outputPreview: (typeof opResult === 'string' ? opResult : JSON.stringify(opResult)).slice(0, 300),
          });

          const opCompleted = completeSubAgent(meta.activeWorkflow, opNodeId, opResult);
          meta.activeWorkflow = opCompleted.updatedPlaybook;

          this.emitPlaybookEvent(state, 'node_completed', { nodeId: opNodeId, nodeLabel: opLabel, output: opResult });
          this.emitEdgeActivations(state, currentPlaybook.definition, opNodeId, 'outgoing');
          await this.saveCheckpoint(opCompleted.updatedPlaybook, opNodeId, opLabel, 'orchestrator-prompt', opResult);

          if (opCompleted.action === 'workflow_completed') {
            this.emitPlaybookEvent(state, 'workflow_completed', {});
            state = await this.releaseWorkflow(state, opCompleted.updatedPlaybook, 'completed');
            return state;
          }
          break;
        }

        case 'prompt_agent': {
          playbookLog('prompt_agent_start', {
            nodeId:        step.updatedPlaybook.pendingDecision?.nodeId,
            promptLength:  step.prompt?.length,
            promptPreview: String(step.prompt).slice(0, 200),
          });
          const decisionNodeId = step.updatedPlaybook.pendingDecision?.nodeId;
          if (decisionNodeId) {
            this.emitEdgeActivations(state, step.updatedPlaybook.definition, decisionNodeId, 'incoming');
            this.emitPlaybookEvent(state, 'node_started', {
              nodeId:    decisionNodeId,
              nodeLabel: this.getPlaybookNodeLabel(step.updatedPlaybook, decisionNodeId),
              prompt:    step.prompt,
            });
          }
          this.injectWorkflowMessage(state, step.prompt);
          state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

          const pendingPlaybook: WorkflowPlaybookState | undefined = meta.activeWorkflow;
          if (pendingPlaybook?.pendingDecision) {
            const msgs = (state as any).messages;
            const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
            if (lastAssistant?.content) {
              const abortAgentState = await this.handleAbortIfSignalled(state, String(lastAssistant.content));
              if (abortAgentState) return abortAgentState;

              const resolvedNodeId = pendingPlaybook.pendingDecision?.nodeId;
              const resolved = resolveDecision(pendingPlaybook, String(lastAssistant.content));
              meta.activeWorkflow = resolved.updatedPlaybook;
              if (resolvedNodeId) {
                const rNodeLabel = this.getPlaybookNodeLabel(pendingPlaybook, resolvedNodeId);
                const rNodeSubtype = this.getPlaybookNodeSubtype(pendingPlaybook, resolvedNodeId);
                this.emitPlaybookEvent(state, 'node_completed', {
                  nodeId:    resolvedNodeId,
                  nodeLabel: rNodeLabel,
                  output:    lastAssistant.content,
                });
                this.emitEdgeActivations(state, pendingPlaybook.definition, resolvedNodeId, 'outgoing');
                await this.saveCheckpoint(resolved.updatedPlaybook, resolvedNodeId, rNodeLabel, rNodeSubtype, lastAssistant.content);
              }
              if (resolved.action === 'workflow_completed' || resolved.action === 'workflow_failed') {
                this.emitPlaybookEvent(state, resolved.action, {});
                const outcome = resolved.action === 'workflow_completed' ? 'completed' : 'failed';
                state = await this.releaseWorkflow(state, resolved.updatedPlaybook, outcome);
                return state;
              }
              break;
            }
          }
          return state;
        }

        case 'spawn_sub_agent': {
          const subNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          const isIntegrationCall = step.agentId === '__integration_call__';
          playbookLog('spawn_sub_agent', {
            nodeId:        step.nodeId,
            label:         subNodeLabel,
            agentId:       step.agentId,
            isIntegrationCall,
            promptLength:  step.prompt?.length,
            promptPreview: String(step.prompt).slice(0, 200),
          });

          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: subNodeLabel, prompt: step.prompt });

          if (isIntegrationCall) {
            const preCallDesc = (step.config.preCallDescription as string) || '';
            const toolInfo = `Integration: ${ step.config.integrationSlug || 'unknown' }\nEndpoint: ${ step.config.endpointName || 'unknown' }`;
            const paramSummary = Object.entries((step.config.defaults as Record<string, string>) || {})
              .map(([k, v]) => `  ${ k }: ${ v }`)
              .join('\n');

            const validatePrompt = `[Workflow Tool Call: ${ subNodeLabel }]\n${ toolInfo }\n${ paramSummary ? `\nParameters:\n${ paramSummary }` : '' }\n${ preCallDesc ? `\nDescription: ${ preCallDesc }` : '' }\n\nValidate these parameters. The tool will execute after your review.`;
            this.injectWorkflowMessage(state, validatePrompt);
            state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

            try {
              const result = await this.executeSubAgent(state, step.nodeId, step.agentId, step.prompt, step.config);
              const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

              this.injectWorkflowMessage(state, `[Tool Call Result: ${ subNodeLabel }]\n${ resultText }`, true);

              const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, result.output, result.threadId);
              meta.activeWorkflow = completed.updatedPlaybook;

              this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, output: resultText });
              this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
              await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subNodeLabel, 'integration-call', resultText);

              if (completed.action === 'workflow_completed') {
                this.emitPlaybookEvent(state, 'workflow_completed', {});
                state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
                return state;
              }
            } catch (err: any) {
              console.error(`[PlaybookController] Tool call failed:`, err);
              this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, error: err.message || String(err) });
              const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
              this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
              state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
              return state;
            }
          } else {
          // Agent Node: orchestrator-mediated deployment
            const agentName = (step.config.agentName as string) || step.agentId || 'default';
            const additionalPrompt = (step.config.additionalPrompt as string) || '';
            const completionContract = (step.config.completionContract as string) || '';
            const successCriteria = (step.config.successCriteria as string) || '';

            // Phase 1: Ask orchestrator to formulate the sub-agent's message
            let formationMsg = `[Workflow: Deploying Agent — ${ subNodeLabel }]\n` +
            `Agent type: ${ agentName }\n\n`;

            if (step.prompt.trim()) {
              formationMsg += `Here are your instructions for deploying this sub-agent:\n${ step.prompt }\n\n`;
            }

            formationMsg += `Formulate the complete task message that will be sent to this sub-agent. Be specific about:\n` +
            `1. What the sub-agent needs to accomplish\n` +
            `2. What completion contract to follow — describe the exact format and content for its final deliverable\n\n`;

            if (completionContract.trim()) {
              formationMsg += `The workflow expects this completion structure:\n${ completionContract }\n\n`;
            }

            formationMsg += `The sub-agent's final response MUST be wrapped in <completion-contract> XML tags.\n` +
            `Include these requirements in your message to the sub-agent.\n\n` +
            `## Delegation\n` +
            `You may delegate work to multiple agents by wrapping each task in a <PROMPT> tag.\n` +
            `Each <PROMPT> spawns one agent in parallel. Attributes:\n` +
            `  agentId="name" (optional — defaults to "${ agentName }")\n` +
            `  label="description" (optional — names the result for downstream reference)\n\n` +
            `Example:\n` +
            `<PROMPT agentId="observer" label="Financial">Watch for financial signals...</PROMPT>\n` +
            `<PROMPT agentId="observer" label="Emotional">Watch for emotional patterns...</PROMPT>\n\n` +
            `If you don't use <PROMPT> tags, your entire response is sent as a single task to the configured agent.\n\n` +
            `Respond with the message(s) to send to the sub-agent(s).`;

            this.injectWorkflowMessage(state, formationMsg);
            (state as any).metadata._muteWsChat = true;
            state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
            (state as any).metadata._muteWsChat = false;

            const lastMsg = (state as any).messages?.[(state as any).messages.length - 1];
            const orchestratorResponse = typeof lastMsg?.content === 'string' ? lastMsg.content : '';

            const abortFormState = await this.handleAbortIfSignalled(state, orchestratorResponse);
            if (abortFormState) return abortFormState;

            const parsedPrompts = parsePromptTags(orchestratorResponse);
            const cleanedMessage = orchestratorResponse
              .replace(/<PROMPT[^>]*>[\s\S]*?<\/PROMPT>/gi, '')
              .replace(/SPAWN_COUNT:\s*\d+\s*/gi, '')
              .trim();

            const contractWrapper = `\nIMPORTANT: When you have completed your task, you MUST wrap your final deliverable in <completion-contract> XML tags:\n` +
            `<completion-contract>\nYour final response here\n</completion-contract>`;

            // Phase 2: Launch sub-agent(s)
            if (parsedPrompts.length > 0) {
            // Batch delegation
              const cappedPrompts = parsedPrompts.slice(0, 10);
              console.log(`[PlaybookController] Orchestrator delegated ${ cappedPrompts.length } prompts for "${ subNodeLabel }"`);
              this.emitPlaybookEvent(state, 'node_parallel_spawn', { nodeId: step.nodeId, nodeLabel: subNodeLabel, count: cappedPrompts.length });

              const delegationSummary = cappedPrompts.map((pp, i) =>
                `  ${ i + 1 }. [${ pp.label || `prompt-${ i }` }] (agent: ${ pp.agentId || agentName })`,
              ).join('\n');
              this.injectWorkflowMessage(state, `[Workflow: Agent Delegation — ${ subNodeLabel }]\nSpawning ${ cappedPrompts.length } agents in parallel:\n${ delegationSummary }\n\nAll agents are launching now.`);
              state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

              const parallelPromises = cappedPrompts.map((pp, i) => {
                const promptParts: string[] = [];
                if (additionalPrompt.trim()) promptParts.push(additionalPrompt);
                promptParts.push(pp.content);
                promptParts.push(contractWrapper);
                const fullPrompt = promptParts.join('\n\n');
                const effectiveAgentId = pp.agentId || step.agentId;
                const instanceId = `${ step.nodeId }-prompt-${ i }`;

                return this.executeSubAgent(state, instanceId, effectiveAgentId, fullPrompt, step.config)
                  .then(result => ({ index: i, label: pp.label || `prompt-${ i }`, result, error: null as string | null }))
                  .catch((err: any) => ({ index: i, label: pp.label || `prompt-${ i }`, result: null as { output: unknown; threadId?: string; contractStatus: 'done' | 'blocked' | 'no_contract' } | null, error: err.message || String(err) }));
              });

              const results = await Promise.allSettled(parallelPromises);

              const successes: { index: number; label: string; resultText: string; threadId?: string }[] = [];
              const failures: { index: number; label: string; error: string }[] = [];

              for (const outcome of results) {
                if (outcome.status === 'fulfilled') {
                  const { index, label, result, error } = outcome.value;
                  if (error || !result) {
                    failures.push({ index, label, error: error || 'Unknown error' });
                  } else if (result.contractStatus === 'no_contract') {
                    failures.push({ index, label, error: 'Sub-graph died without completion contract' });
                  } else if (result.contractStatus === 'blocked') {
                    const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
                    failures.push({ index, label, error: `Blocked: ${ resultText.slice(0, 200) }` });
                  } else {
                    const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
                    successes.push({ index, label, resultText, threadId: result.threadId });
                  }
                } else {
                  failures.push({ index: -1, label: 'unknown', error: outcome.reason?.message || String(outcome.reason) });
                }
              }

              console.log(`[PlaybookController] Delegation "${ subNodeLabel }": ${ successes.length }/${ cappedPrompts.length } succeeded, ${ failures.length } failed`);

              if (successes.length === 0) {
                const errSummary = failures.map(f => `${ f.label }: ${ f.error }`).join('; ');
                this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, error: errSummary });

                const escalationMsg = `[Workflow Node Failed: ${ subNodeLabel }]\n` +
                `All ${ cappedPrompts.length } delegated agents failed.\n` +
                `Errors: ${ errSummary }\n\n` +
                `The workflow "${ currentPlaybook.definition?.name }" is paused. Ask the user what to do.`;

                this.injectWorkflowMessage(state, escalationMsg);
                state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
                return state;
              }

              const batchOutput = {
                strategy: 'delegation',
                merged:   successes.map(s => ({
                  nodeId: `${ step.nodeId }-prompt-${ s.index }`,
                  label:  s.label,
                  result: s.resultText,
                })),
              };

              const failureNote = failures.length > 0
                ? `\n\n(${ failures.length }/${ cappedPrompts.length } agents failed: ${ failures.map(f => `${ f.label }: ${ f.error.slice(0, 100) }`).join('; ') })`
                : '';

              // Phase 3: Orchestrator evaluates with success criteria (batch)
              const batchSummaryText = successes.map(s => {
                const handBack = parseHandBack(s.resultText);
                return `[${ s.label }] ${ handBack.summary || s.resultText.slice(0, 500) }`;
              }).join('\n\n');

              const finalOutput: unknown = batchOutput;
              if (successCriteria.trim()) {
                const evalMsg = `[Sub-agents Complete: ${ subNodeLabel } — ${ successes.length }/${ cappedPrompts.length } agents]\n\n` +
                `${ batchSummaryText }${ failureNote }\n\n` +
                `Evaluate the results against the following success criteria:\n${ successCriteria }\n\n` +
                `If the results meet all criteria, respond with APPROVED and a brief summary.\n` +
                `If they fail any criteria, respond with NEEDS_REVISION and explain what fell short.`;

                this.injectWorkflowMessage(state, evalMsg);
                state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
              } else {
                const resultMsg = `[Workflow Node Complete: ${ subNodeLabel } — ${ successes.length }/${ cappedPrompts.length } agents]\n${ batchSummaryText }${ failureNote }`;
                this.injectWorkflowMessage(state, resultMsg, true);
              }

              const firstThread = successes[0]?.threadId;
              const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, finalOutput, firstThread);
              meta.activeWorkflow = completed.updatedPlaybook;

              this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subNodeLabel, output: JSON.stringify(finalOutput), instanceCount: cappedPrompts.length, succeeded: successes.length, failed: failures.length });
              this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
              await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subNodeLabel, 'agent', JSON.stringify(finalOutput));

              if (completed.action === 'workflow_completed') {
                this.emitPlaybookEvent(state, 'workflow_completed', {});
                state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
                return state;
              }
            } else {
            // Single agent: no <PROMPT> tags — existing non-blocking path
              const subAgentPromptParts: string[] = [];
              if (additionalPrompt.trim()) {
                subAgentPromptParts.push(additionalPrompt);
              }
              subAgentPromptParts.push(cleanedMessage);
              subAgentPromptParts.push(contractWrapper);

              const subAgentPrompt = subAgentPromptParts.join('\n\n');
              const maxRetries = 3;
              const nodeId = step.nodeId;
              const agentId = step.agentId;

              console.log(`[PlaybookController] Launching sub-agent "${ subNodeLabel }" (agent: ${ agentId }) non-blocking`);

              this.pendingSubAgents.set(nodeId, {
                nodeId,
                nodeLabel: subNodeLabel,
                agentId,
                startedAt: Date.now(),
              });

              const pending = this.pendingSubAgents.get(nodeId)!;
              (pending as any).successCriteria = successCriteria;
              (pending as any).completionContract = completionContract;

              this.executeSubAgentWithRetry(state, nodeId, agentId, subAgentPrompt, step.config, subNodeLabel, maxRetries);

              const narrateMsg = `[Workflow: Sub-agent "${ subNodeLabel }" launched]\n` +
              `Agent type: ${ agentName }\n` +
              `Task: ${ cleanedMessage.slice(0, 300) }${ cleanedMessage.length > 300 ? '...' : '' }\n\n` +
              `The sub-agent is now running in the background. Tell the user what you just launched ` +
              `and what it will do. You can continue helping the user while it works.`;

              this.injectWorkflowMessage(state, narrateMsg);
              state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

              return state;
            }
          }
          break;
        }

        case 'spawn_parallel_agents': {
          const parallelNodes = step.nodes;
          const nodeLabels = parallelNodes.map(n => this.getPlaybookNodeLabel(currentPlaybook, n.nodeId));

          for (let i = 0; i < parallelNodes.length; i++) {
            const pn = parallelNodes[i];
            this.emitEdgeActivations(state, currentPlaybook.definition, pn.nodeId, 'incoming');
            this.emitPlaybookEvent(state, 'node_started', { nodeId: pn.nodeId, nodeLabel: nodeLabels[i], prompt: pn.prompt });
          }

          const batchSummary = parallelNodes.map((pn, i) => {
            const isIntegrationCall = pn.agentId === '__integration_call__';
            return `  ${ i + 1 }. [${ nodeLabels[i] }] (${ isIntegrationCall ? 'integration-call' : `agent: ${ pn.config.agentName || pn.agentId || 'default' }` })`;
          }).join('\n');
          this.injectWorkflowMessage(state, `[Workflow: Parallel Execution]\nThe following ${ parallelNodes.length } nodes will execute concurrently:\n${ batchSummary }\n\nAll branches are launching now.`);
          state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

          const parallelPromises = parallelNodes.map(async(pn, i) => {
            const result = await this.executeSubAgent(state, pn.nodeId, pn.agentId, pn.prompt, pn.config);
            return { nodeId: pn.nodeId, label: nodeLabels[i], result, config: pn.config, agentId: pn.agentId };
          });

          const settled = await Promise.allSettled(parallelPromises);

          const successes: { nodeId: string; label: string; resultText: string; threadId?: string }[] = [];
          const failures: { nodeId: string; label: string; error: string }[] = [];

          for (const outcome of settled) {
            if (outcome.status === 'fulfilled') {
              const { nodeId: nId, label, result } = outcome.value;

              if (result.contractStatus === 'no_contract') {
                console.warn(`[PlaybookController] Parallel node "${ label }" returned without contract — graph died mid-execution`);
                this.emitPlaybookEvent(state, 'node_failed', { nodeId: nId, nodeLabel: label, error: 'Sub-graph died without completion contract' });
                failures.push({ nodeId: nId, label, error: 'Sub-graph died without completion contract' });
                continue;
              }

              if (result.contractStatus === 'blocked') {
                const blockText = typeof result.output === 'string' ? result.output : 'Unknown blocker';
                const pnMatch = parallelNodes.find(p => p.nodeId === nId);
                console.log(`[PlaybookController] Parallel node "${ label }" blocked — pushing to escalations`);
                this.pendingEscalations.push({
                  nodeId:    nId,
                  nodeLabel: label,
                  agentId:   pnMatch?.agentId || '',
                  prompt:    pnMatch?.prompt || '',
                  config:    pnMatch?.config || {},
                  question:  blockText.slice(0, 500),
                  threadId:  result.threadId,
                });
                continue;
              }

              const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

              const completed = completeSubAgent(meta.activeWorkflow, nId, result.output, result.threadId);
              meta.activeWorkflow = completed.updatedPlaybook;

              this.emitPlaybookEvent(state, 'node_completed', { nodeId: nId, nodeLabel: label, output: resultText, threadId: result.threadId });
              this.emitEdgeActivations(state, currentPlaybook.definition, nId, 'outgoing');
              const nodeSubtype = this.getPlaybookNodeSubtype(currentPlaybook, nId);
              await this.saveCheckpoint(completed.updatedPlaybook, nId, label, nodeSubtype, resultText);

              successes.push({ nodeId: nId, label, resultText, threadId: result.threadId });
            } else {
              const pn = parallelNodes[settled.indexOf(outcome)];
              const label = this.getPlaybookNodeLabel(currentPlaybook, pn.nodeId);
              const errMsg = outcome.reason?.message || String(outcome.reason);

              this.emitPlaybookEvent(state, 'node_failed', { nodeId: pn.nodeId, nodeLabel: label, error: errMsg });
              failures.push({ nodeId: pn.nodeId, label, error: errMsg });
            }
          }

          if (successes.length === 0 && failures.length > 0) {
            const errSummary = failures.map(f => `${ f.label }: ${ f.error }`).join('; ');
            const failedPlaybook = { ...meta.activeWorkflow, status: 'failed' as const, error: `All parallel branches failed: ${ errSummary }` };
            this.emitPlaybookEvent(state, 'workflow_failed', { error: failedPlaybook.error });
            state = await this.releaseWorkflow(state, failedPlaybook, 'failed', failedPlaybook.error);
            return state;
          }

          const resultsSummary = [
            ...successes.map(s => `  [${ s.label }]: completed`),
            ...failures.map(f => `  [${ f.label }]: FAILED — ${ f.error }`),
          ].join('\n');
          this.injectWorkflowMessage(state, `[Workflow: Parallel Execution Complete]\n${ successes.length }/${ parallelNodes.length } branches succeeded.\n${ resultsSummary }\n\nReview and continue.`, failures.length === 0);
          if (failures.length > 0) {
            state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          }

          if (meta.activeWorkflow?.status === 'completed') {
            this.emitPlaybookEvent(state, 'workflow_completed', {});
            state = await this.releaseWorkflow(state, meta.activeWorkflow, 'completed');
            return state;
          }

          break;
        }

        case 'execute_tool_call': {
          const toolNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: toolNodeLabel });

          try {
            const { toolRegistry } = await import('../tools/registry');
            const tool = await toolRegistry.getTool(step.toolName);
            const toolResult = await tool.call(step.params);

            const resultText = toolResult.success
              ? (toolResult.result || 'Tool completed successfully')
              : `Tool error: ${ toolResult.error || 'Unknown error' }`;

            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, resultText, undefined);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: toolNodeLabel, output: resultText });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
            await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, toolNodeLabel, 'tool-call', resultText);

            const toolCallMsg = `[Workflow Tool Call: ${ toolNodeLabel }]\n` +
            `Tool: ${ step.toolName }\n` +
            `Parameters: ${ JSON.stringify(step.params) }\n\n` +
            `Result:\n${ resultText }`;
            this.injectWorkflowMessage(state, toolCallMsg, true);

            if (completed.action === 'workflow_completed') {
              this.emitPlaybookEvent(state, 'workflow_completed', {});
              state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
              return state;
            }
          } catch (err: any) {
            console.error(`[PlaybookController] Native tool call failed:`, err);
            const errMsg = err.message || String(err);

            const errorResult = `Tool call failed: ${ errMsg }`;
            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, errorResult, undefined);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: toolNodeLabel, output: errorResult });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');

            const errorMsg = `[Workflow Tool Call Failed: ${ toolNodeLabel }]\n` +
            `Tool: ${ step.toolName }\n` +
            `Error: ${ errMsg }\n\n` +
            `The workflow will continue — review the error and decide how to proceed.`;
            this.injectWorkflowMessage(state, errorMsg);
            state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          }

          break;
        }

        case 'execute_function': {
          const fnNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: fnNodeLabel });

          // Default timeout 60s; allow override like "30s" / "2m" / "90".
          function parseTimeoutMs(value: string | null): number {
            if (!value) return 60_000;
            const trimmed = String(value).trim();
            const match = /^(\d+)(ms|s|m|h)?$/i.exec(trimmed);
            if (!match) return 60_000;
            const num = Number(match[1]);
            const unit = (match[2] || 's').toLowerCase();
            const mul = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : 3_600_000;
            return num * mul;
          }

          const RUNTIME_URLS: Record<string, string> = {
            python: 'http://127.0.0.1:30118',
            shell:  'http://127.0.0.1:30119',
            node:   'http://127.0.0.1:30120',
          };
          const SECRETS_HOST_URL = 'http://host.lima.internal:30121';

          // SECURITY: `refs` lives only in this local const + the capability
          // service's in-memory map. It is NEVER passed to saveCheckpoint /
          // emit* / console / injectWorkflowMessage / completeSubAgent
          // results, and no account property VALUES are cached on this side
          // at all — only references (integrationId, accountId, property).
          // The runtime fetches plaintexts just-in-time via /secrets/fetch.
          let mintedToken: string | null = null;
          const invocationId = `fn-${ step.nodeId }-${ Date.now() }-${
            Math.random().toString(36).slice(2, 8) }`;
          let runtime = '';

          try {
            const { resolveSullaFunctionsDir } = await import('@pkg/agent/utils/sullaPaths');
            const yaml = await import('yaml');
            const { getSecretsCapabilityService } = await import(
              '@pkg/agent/services/SecretsCapabilityService');
            const { getIntegrationService } = await import(
              '@pkg/agent/services/IntegrationService');

            const functionsDir = resolveSullaFunctionsDir();
            const yamlPath = pathUtil.join(functionsDir, step.functionRef, 'function.yaml');

            if (!fsSync.existsSync(yamlPath)) {
              throw new Error(`Function not found: ${ step.functionRef } (no function.yaml at ${ yamlPath })`);
            }

            const manifest: any = yaml.parse(fsSync.readFileSync(yamlPath, 'utf-8')) || {};
            runtime = manifest?.spec?.runtime || '';
            const baseUrl = RUNTIME_URLS[runtime];
            if (!baseUrl) {
              throw new Error(`Unknown runtime "${ runtime }" for function "${ step.functionRef }"`);
            }

            // ── Read declared integrations from function.yaml ──
            //   spec.integrations: [{ slug, env: { ENV_NAME: property_name } }]
            const declaredIntegrationsRaw = Array.isArray(manifest?.spec?.integrations)
              ? manifest.spec.integrations
              : [];
            const declaredIntegrations: Array<{ slug: string; env: Record<string, string> }> =
              declaredIntegrationsRaw
                .filter((i: any) => i && typeof i.slug === 'string')
                .map((i: any) => ({
                  slug: i.slug as string,
                  env:  (i.env && typeof i.env === 'object')
                    ? Object.fromEntries(
                      Object.entries(i.env).filter(([, v]) => typeof v === 'string') as [string, string][],
                    )
                    : {},
                }));

            const integrationAccounts = step.integrationAccounts || {};
            const integrationService = getIntegrationService();

            // ── Resolve each integration to a concrete accountId ──
            // User-bound or orchestrator-picked. No account property VALUES
            // are resolved here — only accountIds.
            const resolved: Record<string, string> = {}; // slug → accountId

            for (const intg of declaredIntegrations) {
              const bound = Object.prototype.hasOwnProperty.call(integrationAccounts, intg.slug)
                ? integrationAccounts[intg.slug]
                : undefined;

              let accountId: string | null = bound ?? null;

              if (accountId == null) {
                // ── Orchestrator-pick flow ──
                const accounts = await integrationService.getAccounts(intg.slug);

                if (accounts.length === 0) {
                  throw new Error(
                    `Function ${ step.functionRef } needs a ${ intg.slug } account but none are configured`,
                  );
                }

                const defaultAcct = accounts.find(a => a.active);
                if (accounts.length === 1 && defaultAcct) {
                  // Trivial pick — no prompt needed.
                  accountId = defaultAcct.account_id;
                  console.log(
                    `[PlaybookController] Orchestrator pick trivial for ${ intg.slug }: ` +
                    `single account, no prompt sent (invocation=${ invocationId } node=${ step.nodeId } fn=${ step.functionRef })`,
                  );
                } else {
                  // Build a prompt and ask the orchestrator. Mirror the
                  // existing inline inject + graph.execute + lastAssistant
                  // pattern used for sub-agent escalations.
                  const buildPickPrompt = (retry: boolean): string => {
                    const header = retry
                      ? `Your last reply didn't match any of the listed account_ids. Try again.\n\n`
                      : '';
                    const list = accounts
                      .map(a => `  - \`${ a.account_id }\` — ${ a.label }`)
                      .join('\n');
                    return (
                      `${ header }Function \`${ step.functionRef }\` needs a \`${ intg.slug }\` account. Pick one of:\n` +
                      `${ list }\n\n` +
                      `Respond with only the account_id.`
                    );
                  };

                  const readAccountPick = (): string | null => {
                    const msgs = (state as any).messages;
                    if (!Array.isArray(msgs)) return null;
                    const lastAssistant = [...msgs].reverse().find((m: any) => m.role === 'assistant');
                    const raw = lastAssistant?.content ? String(lastAssistant.content) : '';
                    const candidate = raw.trim();
                    if (!candidate) return null;
                    // Exact match first.
                    const exact = accounts.find(a => a.account_id === candidate);
                    if (exact) return exact.account_id;
                    // Then allow "account_id" appearing as a whole token in the reply.
                    const hit = accounts.find(a =>
                      new RegExp(`(^|[^A-Za-z0-9_-])${ a.account_id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }([^A-Za-z0-9_-]|$)`).test(candidate),
                    );
                    return hit ? hit.account_id : null;
                  };

                  // Attempt 1
                  this.injectWorkflowMessage(state, buildPickPrompt(false));
                  (state as any).metadata._muteWsChat = true;
                  state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
                  (state as any).metadata._muteWsChat = false;

                  let picked = readAccountPick();

                  // One retry on unrecognized response
                  if (!picked) {
                    this.injectWorkflowMessage(state, buildPickPrompt(true));
                    (state as any).metadata._muteWsChat = true;
                    state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
                    (state as any).metadata._muteWsChat = false;
                    picked = readAccountPick();
                  }

                  if (!picked) {
                    throw new Error(
                      `Function ${ step.functionRef } needs a ${ intg.slug } account but orchestrator did not pick a recognized account_id`,
                    );
                  }

                  accountId = picked;
                }
              } else {
                // User-bound accountId — verify it exists.
                // (Orchestrator override of an already-picked account is
                // explicitly DEFERRED to a future enhancement; for v1 we
                // always respect the user's pick.)
                const accounts = await integrationService.getAccounts(intg.slug);
                const exists = accounts.some(a => a.account_id === accountId);
                if (!exists) {
                  throw new Error(
                    `Function ${ step.functionRef } references a ${ intg.slug } account that is not configured`,
                  );
                }
              }

              resolved[intg.slug] = accountId;
            }

            // ── Build refs map for the capability service ──
            // refs: Record<ENV_NAME, { integrationId, accountId, property }>
            // DO NOT log / checkpoint / inject this.
            const refs: Record<string, { integrationId: string; accountId: string; property: string }> = {};
            for (const intg of declaredIntegrations) {
              const accountId = resolved[intg.slug];
              for (const [envName, property] of Object.entries(intg.env)) {
                refs[envName] = {
                  integrationId: intg.slug,
                  accountId,
                  property,
                };
              }
            }

            // Mint the capability token only if at least one env is declared.
            let secretsToken: string | null = null;
            let secretsHostUrl: string | null = null;
            if (Object.keys(refs).length > 0) {
              const svc = getSecretsCapabilityService();
              const minted = svc.mint({
                invocationId,
                refs,
                ttlMs: 60_000,
              });
              mintedToken = minted.token;
              secretsToken = minted.token;
              secretsHostUrl = SECRETS_HOST_URL;
            }

            const timeoutMs = parseTimeoutMs(step.timeoutOverride);
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), timeoutMs);

            console.log(
              `[PlaybookController] Function invoke: ` +
              `invocation=${ invocationId } node=${ step.nodeId } fn=${ step.functionRef } runtime=${ runtime }`,
            );

            let resp: Response;
            try {
              resp = await fetch(`${ baseUrl }/invoke`, {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({
                  name:           step.functionRef,
                  version:        'HEAD',
                  inputs:         step.inputs,
                  secretsToken,
                  secretsHostUrl,
                }),
                signal: ac.signal,
              });
            } finally {
              clearTimeout(timer);
            }

            if (!resp.ok) {
              let detail = `HTTP ${ resp.status }`;
              try {
                const body: any = await resp.json();
                if (body && typeof body.detail === 'string') detail = body.detail;
              } catch { /* non-JSON body — keep status string */ }
              // The runtime is responsible for scrubbing its own error
              // strings before returning them. We don't cache any secret
              // values here, so there is nothing to re-scrub on our side.
              throw new Error(detail);
            }

            const payload: any = await resp.json();
            const outputs = payload?.outputs ?? {};
            const durationMs = Number(payload?.duration_ms) || 0;

            const result = { outputs, durationMs };

            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, result, undefined);
            meta.activeWorkflow = completed.updatedPlaybook;

            const resultText = JSON.stringify(result);
            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: fnNodeLabel, output: resultText });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
            // NOTE: checkpoint carries only inputs + outputs. No token,
            // no refs, no secretsHostUrl, no resolved accountIds.
            await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, fnNodeLabel, 'function', resultText);

            const fnMsg = `[Workflow Function: ${ fnNodeLabel }]\n` +
              `Function: ${ step.functionRef } (${ runtime })\n` +
              `Inputs: ${ JSON.stringify(step.inputs) }\n` +
              `Duration: ${ durationMs }ms\n\n` +
              `Outputs:\n${ JSON.stringify(outputs) }`;
            this.injectWorkflowMessage(state, fnMsg, true);

            if (completed.action === 'workflow_completed') {
              this.emitPlaybookEvent(state, 'workflow_completed', {});
              state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
              return state;
            }
          } catch (err: any) {
            const errMsg = err?.name === 'AbortError'
              ? `Function call timed out`
              : (err?.message || String(err));
            console.error(
              `[PlaybookController] Function call failed: ` +
              `invocation=${ invocationId } node=${ step.nodeId } fn=${ step.functionRef } — ${ errMsg }`,
            );

            const errorResult = `Function call failed: ${ errMsg }`;
            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, errorResult, undefined);
            meta.activeWorkflow = completed.updatedPlaybook;

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: fnNodeLabel, output: errorResult });
            this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');

            const errorMsg = `[Workflow Function Failed: ${ fnNodeLabel }]\n` +
              `Function: ${ step.functionRef }\n` +
              `Error: ${ errMsg }\n\n` +
              `The workflow will continue — review the error and decide how to proceed.`;
            this.injectWorkflowMessage(state, errorMsg);
            state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });
          } finally {
            // Always invalidate the capability token — whether invoke
            // succeeded, failed, or threw — so it can't be replayed.
            if (mintedToken) {
              try {
                const { getSecretsCapabilityService } = await import(
                  '@pkg/agent/services/SecretsCapabilityService');
                getSecretsCapabilityService().invalidate(mintedToken);
              } catch {
                // best-effort — service sweep will clean up on TTL anyway
              }
              mintedToken = null;
            }
          }

          break;
        }

        case 'spawn_sub_workflow': {
          const subWfLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          playbookLog('spawn_sub_workflow', {
            nodeId:         step.nodeId,
            label:          subWfLabel,
            workflowId:     step.workflowId,
            agentId:        step.agentId,
            payloadPreview: step.payload ? String(step.payload).slice(0, 200) : undefined,
          });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: subWfLabel });

          try {
            const { getWorkflowRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
            const subRegistry = getWorkflowRegistry();
            const subDefinition = await subRegistry.loadWorkflow(step.workflowId);

            if (!subDefinition) {
              throw new Error(`Sub-workflow not found: ${ step.workflowId }`);
            }

            if (step.agentId) {
              console.log(`[PlaybookController] Delegating sub-workflow "${ subWfLabel }" to agent "${ step.agentId }"`);

              const { GraphRegistry } = await import('../services/GraphRegistry');
              const threadId = `workflow-subwf-${ step.nodeId }-${ Date.now() }`;
              const { graph: subGraph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(step.agentId, threadId) as {
                graph: any;
                state: any;
              };

              const subPlaybook = createPlaybookState(subDefinition, step.payload);
              subState.metadata.activeWorkflow = subPlaybook;
              subState.metadata.isSubAgent = true;

              const parentChannel = (state as any).metadata?.wsChannel || 'workbench';
              subState.metadata.workflowNodeId = step.nodeId;
              subState.metadata.workflowParentChannel = parentChannel;

              const basePrompt = `You are orchestrating the workflow "${ subDefinition.name }". ` +
              `Process it step by step using your persona, tools, and judgment. ` +
              `The workflow has been loaded into your active playbook.`;
              const fullPrompt = step.orchestratorPrompt
                ? `${ basePrompt }\n\nAdditional instructions from the parent workflow:\n${ step.orchestratorPrompt }`
                : basePrompt;
              subState.messages.push({ role: 'user', content: fullPrompt });

              const finalSubState = await subGraph.execute(subState);

              const subOutputs = Object.values(finalSubState.metadata?.activeWorkflow?.nodeOutputs ?? {}) as Array<{ result?: unknown }>;
              const lastOutput = subOutputs[subOutputs.length - 1];
              const subResult = lastOutput?.result ?? null;

              const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, subResult, threadId);
              meta.activeWorkflow = completed.updatedPlaybook;

              this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: subWfLabel, output: subResult });
              this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
              await this.saveCheckpoint(completed.updatedPlaybook, step.nodeId, subWfLabel, 'sub-workflow', subResult);

              const resultText = typeof subResult === 'string' ? subResult : JSON.stringify(subResult);
              this.injectWorkflowMessage(state, `[Sub-workflow Complete: ${ subWfLabel }]\nOrchestrated by agent "${ step.agentId }"\nResult: ${ (resultText || '').substring(0, 500) }${ (resultText || '').length > 500 ? '...' : '' }`);

              if (completed.action === 'workflow_completed') {
                this.emitPlaybookEvent(state, 'workflow_completed', {});
                state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
                return state;
              }
            } else {
              const parentPlaybook = meta.activeWorkflow;
              if (!meta.workflowStack) meta.workflowStack = [];
              meta.workflowStack.push({ playbook: parentPlaybook, nodeId: step.nodeId });

              const subPlaybook = createPlaybookState(subDefinition, step.payload);
              meta.activeWorkflow = subPlaybook;
            }
            break;
          } catch (err: any) {
            console.error(`[PlaybookController] Sub-workflow failed to load:`, err);
            this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: subWfLabel, error: err.message || String(err) });
            const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
            this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
            state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
            return state;
          }
        }

        case 'transfer_workflow': {
          const transferLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          console.log(`[PlaybookController] Transfer to workflow "${ step.targetWorkflowId }" from node "${ step.nodeId }"`);

          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: transferLabel });

          try {
            const { getWorkflowRegistry: getTransferRegistry } = await import('@pkg/agent/workflow/WorkflowRegistry');
            const transferRegistry = getTransferRegistry();
            const targetDefinition = await transferRegistry.loadWorkflow(step.targetWorkflowId);

            if (!targetDefinition) {
              throw new Error(`Transfer target workflow not found: ${ step.targetWorkflowId }`);
            }

            this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: transferLabel, output: { transferred: step.targetWorkflowId } });
            await this.saveCheckpoint(step.updatedPlaybook, step.nodeId, transferLabel, 'transfer', { transferred: step.targetWorkflowId });

            const outgoingPlaybook = meta.activeWorkflow as WorkflowPlaybookState;
            const nodeSummaries = Object.values(outgoingPlaybook.nodeOutputs ?? {}).map((output: PlaybookNodeOutput) => ({
              nodeId:   output.nodeId,
              label:    output.label,
              subtype:  output.subtype,
              category: output.category,
              result:   typeof output.result === 'string' ? output.result : JSON.stringify(output.result),
              threadId: output.threadId,
            }));

            meta.lastCompletedWorkflow = {
              workflowId:    outgoingPlaybook.workflowId,
              workflowName:  outgoingPlaybook.definition.name,
              executionId:   outgoingPlaybook.executionId,
              outcome:       'completed',
              startedAt:     outgoingPlaybook.startedAt,
              completedAt:   new Date().toISOString(),
              nodeResults:   nodeSummaries,
              transferredTo: step.targetWorkflowId,
            };

            meta.workflowStack = [];
            this.emitPlaybookEvent(state, 'workflow_completed', {});

            const targetPlaybook = createPlaybookState(targetDefinition, step.payload);
            meta.activeWorkflow = targetPlaybook;

            console.log(`[PlaybookController] Transferred to "${ targetDefinition.name }" (${ targetPlaybook.executionId })`);

            this.injectWorkflowMessage(state, `[Workflow Transfer] The workflow "${ outgoingPlaybook.definition.name }" has handed off to "${ targetDefinition.name }". The new workflow is now active.`);

            break;
          } catch (err: any) {
            console.error(`[PlaybookController] Transfer failed:`, err);
            this.emitPlaybookEvent(state, 'node_failed', { nodeId: step.nodeId, nodeLabel: transferLabel, error: err.message || String(err) });
            const failedPlaybook = { ...meta.activeWorkflow, status: 'failed', error: err.message || String(err) };
            this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
            state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
            return state;
          }
        }

        case 'node_completed': {
          const mechLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: mechLabel });
          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: mechLabel, output: step.result });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
          await this.saveCheckpoint(step.updatedPlaybook, step.nodeId, mechLabel, this.getPlaybookNodeSubtype(currentPlaybook, step.nodeId), step.result);
          break;
        }

        case 'wait': {
          const waitLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: waitLabel });

          const abortService = meta.options?.abort;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, step.durationMs);
            if (abortService?.signal) {
              const onAbort = () => { clearTimeout(timer); reject(new Error('AbortError')) };
              if (abortService.signal.aborted) { clearTimeout(timer); reject(new Error('AbortError')); return }
              abortService.signal.addEventListener('abort', onAbort, { once: true });
            }
          });
          throwIfAborted(abortService);

          const waitNode = meta.activeWorkflow.definition.nodes.find((n: any) => n.id === step.nodeId);
          if (waitNode) {
            const completed = completeSubAgent(meta.activeWorkflow, step.nodeId, `Waited ${ step.durationMs }ms`);
            meta.activeWorkflow = completed.updatedPlaybook;
          }
          this.emitPlaybookEvent(state, 'node_completed', { nodeId: step.nodeId, nodeLabel: waitLabel, output: `Waited ${ step.durationMs }ms` });
          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'outgoing');
          await this.saveCheckpoint(meta.activeWorkflow, step.nodeId, waitLabel, 'wait', `Waited ${ step.durationMs }ms`);
          break;
        }

        case 'await_user_input': {
          const uiNodeLabel = this.getPlaybookNodeLabel(currentPlaybook, step.nodeId);
          console.log(`[PlaybookController] User input node "${ step.nodeId }" — waiting for user response`);

          this.emitEdgeActivations(state, currentPlaybook.definition, step.nodeId, 'incoming');
          this.emitPlaybookEvent(state, 'node_started', { nodeId: step.nodeId, nodeLabel: uiNodeLabel });
          this.emitPlaybookEvent(state, 'node_waiting', { nodeId: step.nodeId, nodeLabel: uiNodeLabel, output: { promptText: step.promptText } });

          this.injectWorkflowMessage(state, `[Workflow: User Input Required]\nThe workflow needs input from the user before it can continue.\n\nPrompt to present: ${ step.promptText }\n\nAsk the user this question now. Do NOT answer it yourself — wait for the user to respond.`);

          state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

          return state;
        }

        case 'workflow_completed': {
          playbookLog('workflow_completed', {
            workflowId:     step.updatedPlaybook?.definition?.id,
            completedNodes: step.updatedPlaybook?.completedNodeIds,
            nodeOutputKeys: Object.keys(step.updatedPlaybook?.nodeOutputs ?? {}),
          });
          const onlyTriggersCompleted = Object.values(step.updatedPlaybook.nodeOutputs ?? {})
            .every((o: PlaybookNodeOutput) => o.category === 'trigger');
          if (onlyTriggersCompleted) {
            console.error(`[PlaybookController] BUG: Workflow completed with only triggers done. Frontier: [${ currentPlaybook.currentNodeIds }], completedIds: [${ currentPlaybook.completedNodeIds }]`);
          }

          if (meta.workflowStack?.length > 0) {
            const parent = meta.workflowStack.pop();
            const subOutputs = Object.values(step.updatedPlaybook.nodeOutputs ?? {});
            const lastOutput = subOutputs[subOutputs.length - 1];
            const subResult = lastOutput?.result ?? null;

            this.emitPlaybookEvent(state, 'workflow_completed', {});

            const completed = completeSubAgent(parent.playbook, parent.nodeId, subResult);
            meta.activeWorkflow = completed.updatedPlaybook;

            const parentNodeLabel = this.getPlaybookNodeLabel(parent.playbook, parent.nodeId);
            this.emitPlaybookEvent(state, 'node_completed', { nodeId: parent.nodeId, nodeLabel: parentNodeLabel, output: subResult });
            this.emitEdgeActivations(state, parent.playbook.definition, parent.nodeId, 'outgoing');
            await this.saveCheckpoint(completed.updatedPlaybook, parent.nodeId, parentNodeLabel, 'sub-workflow', subResult);

            if (completed.action === 'workflow_completed') {
              this.emitPlaybookEvent(state, 'workflow_completed', {});
              state = await this.releaseWorkflow(state, completed.updatedPlaybook, 'completed');
              return state;
            }
            break;
          }

          this.emitPlaybookEvent(state, 'workflow_completed', {});
          state = await this.releaseWorkflow(state, step.updatedPlaybook, 'completed');
          return state;
        }

        case 'workflow_failed': {
          playbookLog('workflow_failed', {
            workflowId: step.updatedPlaybook?.definition?.id,
            error:      step.error,
          });
          if (meta.workflowStack?.length > 0) {
            const parent = meta.workflowStack.pop();
            console.error(`[PlaybookController] Sub-workflow failed: ${ step.error }, propagating to parent node "${ parent.nodeId }"`);
            this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
            this.emitPlaybookEvent(state, 'node_failed', { nodeId: parent.nodeId, error: step.error });

            const failedParent = { ...parent.playbook, status: 'failed' as const, error: step.error };
            meta.activeWorkflow = failedParent;
            this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
            state = await this.releaseWorkflow(state, failedParent, 'failed', step.error);
            return state;
          }

          console.error(`[PlaybookController] Workflow failed: ${ step.error }`);
          this.emitPlaybookEvent(state, 'workflow_failed', { error: step.error });
          state = await this.releaseWorkflow(state, step.updatedPlaybook, 'failed', step.error);
          return state;
        }
        case 'waiting_for_sub_agents': {
          const waitingLabels = step.blockedNodeIds.map(id => this.getPlaybookNodeLabel(currentPlaybook, id));
          console.log(`[PlaybookController] Waiting for sub-agents: ${ waitingLabels.join(', ') } (missing upstream: ${ step.missingUpstream.join(', ') })`);
          return state;
        }
        default:
          console.warn(`[PlaybookController] Unhandled step action: ${ (step as any).action }`);
          break;
        }
      }
    } catch (err: any) {
      console.error(`[PlaybookController] Walker crashed:`, err);
      const failedPlaybook = { ...meta.activeWorkflow, status: 'failed' as const, error: err.message || String(err) };
      this.emitPlaybookEvent(state, 'workflow_failed', { error: err.message || String(err) });
      state = await this.releaseWorkflow(state, failedPlaybook, 'failed', err.message || String(err));
    }

    return state;
  }

  // ─── WebSocket Event Emission ───────────────────────────────────

  private emitPlaybookEvent(state: TState, type: string, data: Record<string, unknown> = {}): void {
    try {
      const ws = getWebSocketClientService();
      const channel = (state as any).metadata?.wsChannel || 'workbench';
      const meta = (state as any).metadata ?? {};
      const playbook = meta.activeWorkflow;

      let totalNodes = 0;
      let nodeIndex = 0;

      if (playbook?.definition?.nodes) {
        const executableNodes = (playbook.definition.nodes as any[]).filter(
          (n: any) => n.data?.category !== 'trigger',
        );

        totalNodes = executableNodes.length;
        nodeIndex = Object.keys(playbook.nodeOutputs ?? {}).length;
      }

      ws.send(channel, {
        type:      'workflow_execution_event',
        data:      {
          type, thread_id: meta.threadId, timestamp: new Date().toISOString(), totalNodes, nodeIndex, ...data,
        },
        timestamp: Date.now(),
      });
    } catch { /* best-effort */ }
  }

  private emitEdgeActivations(
    state: TState,
    definition: { edges: { source: string; target: string }[] },
    nodeId: string,
    direction: 'incoming' | 'outgoing',
  ): void {
    for (const edge of definition.edges) {
      if (direction === 'incoming' && edge.target === nodeId) {
        this.emitPlaybookEvent(state, 'edge_activated', { sourceId: edge.source, targetId: edge.target });
      } else if (direction === 'outgoing' && edge.source === nodeId) {
        this.emitPlaybookEvent(state, 'edge_activated', { sourceId: edge.source, targetId: edge.target });
      }
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private getPlaybookNodeLabel(playbook: WorkflowPlaybookState, nodeId: string): string {
    const node = playbook.definition.nodes.find((n: any) => n.id === nodeId);
    return node?.data?.label || nodeId;
  }

  private getPlaybookNodeSubtype(playbook: WorkflowPlaybookState, nodeId: string): string {
    const node = playbook.definition.nodes.find((n: any) => n.id === nodeId);
    return node?.data?.subtype || 'unknown';
  }

  private injectWorkflowMessage(state: TState, content: string, _silent?: boolean): void {
    const msgs = (state as any).messages;
    if (Array.isArray(msgs)) {
      msgs.push({ role: 'user', content: `[Workflow] ${ content }` });
    }
  }

  // ─── Checkpoint ─────────────────────────────────────────────────

  private async saveCheckpoint(
    playbook: WorkflowPlaybookState,
    nodeId: string,
    nodeLabel: string,
    nodeSubtype: string,
    nodeOutput: unknown,
  ): Promise<void> {
    try {
      const { WorkflowCheckpointModel } = await import('../database/models/WorkflowCheckpointModel');
      const sequence = Object.keys(playbook.nodeOutputs ?? {}).length;

      const slimPlaybook = {
        ...playbook,
        definition: {
          ...playbook.definition,
          nodes: playbook.definition.nodes.map(n => ({
            id:       n.id,
            type:     n.type,
            position: n.position,
            data:     { subtype: n.data.subtype, category: n.data.category, label: n.data.label, config: n.data.config },
          })),
        },
      };

      await WorkflowCheckpointModel.saveCheckpoint({
        executionId:   playbook.executionId,
        workflowId:    playbook.workflowId,
        workflowName:  playbook.definition.name,
        nodeId,
        nodeLabel,
        nodeSubtype,
        sequence,
        playbookState: slimPlaybook as any,
        nodeOutput,
      });
    } catch (err) {
      console.warn(`[PlaybookController:Checkpoint] Failed to save checkpoint for "${ nodeLabel }":`, err);
    }
  }

  // ─── Abort Workflow Detection ───────────────────────────────────

  private checkForAbortWorkflow(response: string): string | null {
    const match = /<ABORT_WORKFLOW>([\s\S]*?)<\/ABORT_WORKFLOW>/i.exec(response);
    return match ? match[1].trim() : null;
  }

  private async handleAbortIfSignalled(state: TState, response: string): Promise<TState | null> {
    const reason = this.checkForAbortWorkflow(response);
    if (!reason) return null;

    const meta = (state as any).metadata;
    const playbook: WorkflowPlaybookState | undefined = meta?.activeWorkflow;
    if (!playbook) return null;

    console.log(`[PlaybookController] Orchestrator aborted workflow: ${ reason }`);
    playbookLog('orchestrator_abort', { reason, workflowId: playbook.workflowId });

    this.emitPlaybookEvent(state, 'workflow_aborted', { reason });
    this.pendingSubAgents.clear();

    state = await this.releaseWorkflow(state, playbook, 'failed', `Aborted by orchestrator: ${ reason }`);
    return state;
  }

  // ─── Release Workflow ───────────────────────────────────────────

  private async releaseWorkflow(
    state: TState,
    playbook: WorkflowPlaybookState,
    outcome: 'completed' | 'failed',
    error?: string,
  ): Promise<TState> {
    const meta = (state as any).metadata;

    const nodeSummaries = Object.values(playbook.nodeOutputs ?? {}).map((output: PlaybookNodeOutput) => ({
      nodeId:    output.nodeId,
      label:     output.label,
      subtype:   output.subtype,
      category:  output.category,
      result:    typeof output.result === 'string' ? output.result : JSON.stringify(output.result),
      threadId:  output.threadId,
    }));

    meta.lastCompletedWorkflow = {
      workflowId:   playbook.workflowId,
      workflowName: playbook.definition.name,
      executionId:  playbook.executionId,
      outcome,
      error:        error || undefined,
      startedAt:    playbook.startedAt,
      completedAt:  new Date().toISOString(),
      nodeResults:  nodeSummaries,
    };

    meta.activeWorkflow = undefined;

    const nodeLines = nodeSummaries
      .filter(n => n.category !== 'trigger')
      .map(n => `  • ${ n.label } (${ n.subtype }): ${ (n.result || '').substring(0, 200) }${ (n.result || '').length > 200 ? '...' : '' }`)
      .join('\n');

    const statusLabel = outcome === 'completed' ? 'completed successfully' : `failed: ${ error || 'unknown error' }`;
    const summaryMsg = `[Workflow Complete] The workflow "${ playbook.definition.name }" has ${ statusLabel }.\n\nNode results:\n${ nodeLines }\n\nYou are now free from the workflow. Continue the conversation naturally — you have full context of what was accomplished above. Respond to the user as needed.`;

    this.injectWorkflowMessage(state, summaryMsg);

    state = await this.graph.execute(state, this.graph.getEntryPoint() || undefined, { maxIterations: 1000000, _isPlaybookReentry: true });

    return state;
  }

  // ─── Sub-Agent Execution ────────────────────────────────────────

  private async executeSubAgent(
    _state: TState,
    nodeId: string,
    agentId: string,
    prompt: string,
    config: Record<string, unknown>,
  ): Promise<{ output: unknown; threadId?: string; contractStatus: 'done' | 'blocked' | 'no_contract' }> {
    if (agentId === '__integration_call__') {
      const result = await this.executeToolCall(config);
      return { ...result, contractStatus: 'done' };
    }

    const { GraphRegistry } = await import('../services/GraphRegistry');

    const threadId = `workflow-playbook-${ nodeId }-${ Date.now() }`;
    const agentConfigChannel = agentId || threadId;

    const { graph, state: subState } = await GraphRegistry.getOrCreateAgentGraph(agentConfigChannel, threadId) as {
      graph: any;
      state: any;
    };

    subState.messages.push({ role: 'user', content: prompt });

    subState.metadata.isSubAgent = true;

    const parentChannel = (_state as any).metadata?.wsChannel || 'workbench';
    subState.metadata.workflowNodeId = nodeId;
    subState.metadata.workflowParentChannel = parentChannel;

    const finalState = await graph.execute(subState);

    const agentMeta = (finalState.metadata)?.agent || {};
    const agentStatus = String(agentMeta.status || '').toLowerCase();

    if (agentStatus === 'blocked') {
      const blockerReason = agentMeta.blocker_reason || 'Unknown blocker';
      const unblockReqs = agentMeta.unblock_requirements || '';
      return {
        output:         `[BLOCKED] ${ blockerReason }${ unblockReqs ? ` | Requirements: ${ unblockReqs }` : '' }`,
        threadId,
        contractStatus: 'blocked',
      };
    }

    if (agentStatus === 'done') {
      const output = finalState.metadata?.finalSummary ||
        finalState.messages?.[finalState.messages.length - 1]?.content ||
        '';
      return { output, threadId, contractStatus: 'done' };
    }

    const partialOutput = finalState.metadata?.finalSummary ||
      finalState.messages?.[finalState.messages.length - 1]?.content ||
      '';
    console.warn(`[PlaybookController:executeSubAgent] Sub-graph "${ agentId }" returned without contract. agentStatus="${ agentStatus }", messages=${ finalState.messages?.length ?? 0 }, threadId=${ threadId }`);

    return { output: partialOutput, threadId, contractStatus: 'no_contract' };
  }

  // ─── Sub-Agent With Retry ───────────────────────────────────────

  private executeSubAgentWithRetry(
    state: TState,
    nodeId: string,
    agentId: string,
    prompt: string,
    config: Record<string, unknown>,
    nodeLabel: string,
    maxRetries: number,
  ): void {
    const attempt = async(attemptNum: number): Promise<void> => {
      try {
        console.log(`[PlaybookController] Sub-agent "${ nodeLabel }" attempt ${ attemptNum }/${ maxRetries }`);
        const result = await this.executeSubAgent(state, nodeId, agentId, prompt, config);
        const resultText = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);

        if (result.contractStatus === 'blocked') {
          console.log(`[PlaybookController] Sub-agent "${ nodeLabel }" blocked — escalating (orchestrator will attempt to answer first)`);
          this.pendingSubAgents.delete(nodeId);
          this.pendingEscalations.push({
            nodeId,
            nodeLabel,
            agentId,
            prompt,
            config,
            question: resultText,
            threadId: result.threadId,
          });

          const escExecId = (state as any).metadata?.activeWorkflow?.executionId;
          if (escExecId) {
            import('../database/models/WorkflowPendingCompletionModel').then(({ WorkflowPendingCompletionModel }) => {
              WorkflowPendingCompletionModel.saveEscalation({ executionId: escExecId, nodeId, nodeLabel, agentId, prompt, config, question: resultText, threadId: result.threadId })
                .catch(e => console.warn('[PlaybookController] Failed to persist escalation to DB:', e));
            }).catch(() => { /* best-effort */ });
          }

          try {
            const ws = getWebSocketClientService();
            const channel = (state as any).metadata?.wsChannel || 'workbench';
            ws.send(channel, {
              type:      'workflow_execution_event',
              data:      {
                type:      'sub_agent_blocked',
                nodeId,
                nodeLabel,
                question:  resultText.slice(0, 500),
                timestamp: new Date().toISOString(),
              },
              timestamp: Date.now(),
            });
          } catch { /* best-effort */ }

          this.triggerPlaybookContinuation(state);
          return;
        }

        if (result.contractStatus === 'no_contract' && attemptNum < maxRetries) {
          console.warn(`[PlaybookController] Sub-agent "${ nodeLabel }" returned without contract (attempt ${ attemptNum }), retrying...`);
          this.emitPlaybookEvent(state, 'node_retrying', { nodeId, nodeLabel, attempt: attemptNum, reason: 'no_contract' });
          return attempt(attemptNum + 1);
        }

        if (result.contractStatus === 'done' || attemptNum >= maxRetries) {
          this.pendingCompletions.push({ nodeId, nodeLabel, output: result.output, threadId: result.threadId });

          const execId = (state as any).metadata?.activeWorkflow?.executionId;
          if (execId) {
            import('../database/models/WorkflowPendingCompletionModel').then(({ WorkflowPendingCompletionModel }) => {
              WorkflowPendingCompletionModel.saveCompletion({ executionId: execId, nodeId, nodeLabel, output: result.output, threadId: result.threadId })
                .catch(e => console.warn('[PlaybookController] Failed to persist completion to DB:', e));
            }).catch(() => { /* best-effort */ });
          }

          try {
            const ws = getWebSocketClientService();
            const channel = (state as any).metadata?.wsChannel || 'workbench';
            ws.send(channel, {
              type: 'workflow_execution_event',
              data: {
                type:      'sub_agent_completed',
                nodeId,
                nodeLabel,
                output:    resultText.slice(0, 500),
                threadId:  result.threadId,
                timestamp: new Date().toISOString(),
              },
              timestamp: Date.now(),
            });
          } catch { /* best-effort */ }

          this.triggerPlaybookContinuation(state);
        }
      } catch (err: any) {
        const errorMsg = err.message || String(err);
        console.error(`[PlaybookController] Sub-agent "${ nodeLabel }" threw (attempt ${ attemptNum }/${ maxRetries }):`, errorMsg);

        if (attemptNum < maxRetries) {
          this.emitPlaybookEvent(state, 'node_retrying', { nodeId, nodeLabel, attempt: attemptNum, reason: 'exception', error: errorMsg });
          return attempt(attemptNum + 1);
        }

        this.pendingFailures.push({ nodeId, nodeLabel, error: errorMsg });

        const failExecId = (state as any).metadata?.activeWorkflow?.executionId;
        if (failExecId) {
          import('../database/models/WorkflowPendingCompletionModel').then(({ WorkflowPendingCompletionModel }) => {
            WorkflowPendingCompletionModel.saveFailure({ executionId: failExecId, nodeId, nodeLabel, error: errorMsg })
              .catch(e => console.warn('[PlaybookController] Failed to persist failure to DB:', e));
          }).catch(() => { /* best-effort */ });
        }

        try {
          const ws = getWebSocketClientService();
          const channel = (state as any).metadata?.wsChannel || 'workbench';
          ws.send(channel, {
            type: 'workflow_execution_event',
            data: {
              type:      'sub_agent_failed',
              nodeId,
              nodeLabel,
              error:     errorMsg,
              timestamp: new Date().toISOString(),
            },
            timestamp: Date.now(),
          });
        } catch { /* best-effort */ }

        this.triggerPlaybookContinuation(state);
      }
    };

    attempt(1).catch(err => {
      console.error(`[PlaybookController] executeSubAgentWithRetry unhandled error:`, err);
    });
  }

  // ─── Continuation Trigger ───────────────────────────────────────

  private triggerPlaybookContinuation(state: TState): void {
    if (this.isProcessingPlaybook) {
      this._continuationQueued = true;
      console.log('[PlaybookController] Playbook already processing, queued continuation for after unlock');
      return;
    }

    const meta = (state as any).metadata;
    if (meta?.waitingForUser || meta?.cycleComplete) {
      const channel = meta?.wsChannel;
      const threadId = meta?.threadId;
      if (channel && threadId) {
        console.log(`[PlaybookController] Graph is idle — sending WS wake-up on channel "${ channel }"`);
        try {
          const ws = getWebSocketClientService();
          ws.send(channel, {
            type: 'user_message',
            data: {
              content:  '[Workflow continuation: sub-agent completed]',
              threadId,
              metadata: { origin: 'workflow_continuation' },
            },
            timestamp: Date.now(),
          });
        } catch (err) {
          console.warn('[PlaybookController] Failed to send WS wake-up:', err);
        }
        return;
      }
    }

    setImmediate(async() => {
      if (this.isProcessingPlaybook) {
        this._continuationQueued = true;
        return;
      }
      try {
        console.log('[PlaybookController] Triggering playbook continuation after sub-agent completion');
        await this.processWorkflowPlaybook(state);
      } catch (err) {
        console.error('[PlaybookController] Post-completion playbook processing failed:', err);
      }
    });
  }

  // ─── Tool Call Execution ────────────────────────────────────────

  private async executeToolCall(config: Record<string, unknown>): Promise<{ output: unknown }> {
    const integrationSlug = (config.integrationSlug as string) || '';
    const endpointName = (config.endpointName as string) || '';
    const accountId = (config.accountId as string) || 'default';
    const defaults = (config.defaults as Record<string, string>) || {};

    if (!integrationSlug || !endpointName) {
      return { output: { error: 'Missing integration or endpoint configuration' } };
    }

    const { getIntegrationConfigLoader } = await import('../integrations/configApi');
    const loader = getIntegrationConfigLoader();
    const client = loader.getClient(integrationSlug);

    if (!client) {
      return { output: { error: `Integration "${ integrationSlug }" not found` } };
    }

    const options: Record<string, any> = {};
    try {
      const { getIntegrationService } = await import('../services/IntegrationService');
      const integrationService = getIntegrationService();
      const values = await integrationService.getFormValues(integrationSlug, accountId);
      const apiKeyVal = values.find((v: { property: string; value: string }) =>
        v.property === 'api_key' || v.property === 'apiKey' || v.property === 'token',
      );
      if (apiKeyVal?.value) options.apiKey = apiKeyVal.value;
      const tokenVal = values.find((v: { property: string; value: string }) => v.property === 'access_token');
      if (tokenVal?.value) options.token = tokenVal.value;
    } catch (err) {
      console.warn('[PlaybookController] Could not load credentials:', err);
    }

    const result = await client.call(endpointName, defaults, options);
    return { output: result };
  }
}
