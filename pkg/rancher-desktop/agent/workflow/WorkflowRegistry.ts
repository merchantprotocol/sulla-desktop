/**
 * WorkflowRegistry — routes incoming messages to the right workflow.
 *
 * External trigger sources (calendar, chat apps, desktop, API) call the registry
 * with a trigger type and a user message. The registry:
 *
 * 1. Scans all saved workflows for trigger nodes matching that type
 * 2. If one match → runs it directly
 * 3. If multiple matches → uses LLM to pick the best one based on triggerDescription
 * 4. Can also be called with a specific workflowId to skip selection
 */

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import type {
  WorkflowDefinition,
  TriggerNodeSubtype,
} from '@pkg/pages/editor/workflow/types';

import { WorkflowExecutor } from './WorkflowExecutor';
import type { WorkflowExecutionEvent, WorkflowRunState } from './types';

// ── Types ──

export interface WorkflowDispatchOptions {
  /** The trigger type (e.g. 'calendar', 'chat-app', 'sulla-desktop') */
  triggerType: TriggerNodeSubtype;
  /** The user message or payload that triggered this */
  message: string;
  /** Optional: skip LLM selection and run this specific workflow */
  workflowId?: string;
  /** The originating WebSocket channel so agent nodes route responses back correctly */
  originChannel?: string;
  /** Callback for execution events (forwarded to the executor) */
  emitEvent?: (event: Omit<WorkflowExecutionEvent, 'executionId' | 'workflowId' | 'timestamp'>) => void;
}

export interface WorkflowDispatchResult {
  executionId: string;
  workflowId: string;
  workflowName: string;
  executor: WorkflowExecutor;
}

interface WorkflowCandidate {
  definition: WorkflowDefinition;
  triggerDescription: string;
}

// ── Registry ──

export class WorkflowRegistry {
  private workflowsDir: string;

  constructor(workflowsDir: string) {
    this.workflowsDir = workflowsDir;
  }

  /**
   * Dispatch a message to the appropriate workflow.
   * Returns the executor so callers can track or abort it.
   */
  async dispatch(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult | null> {
    const { triggerType, message, workflowId, emitEvent } = options;

    console.log(`[WorkflowRegistry] dispatch() called — triggerType="${triggerType}", workflowId="${workflowId || '(auto)'}", originChannel="${options.originChannel || '(none)'}", message="${message.slice(0, 80)}"`);

    let definition: WorkflowDefinition;

    if (workflowId) {
      // Direct dispatch — skip selection
      console.log(`[WorkflowRegistry] Direct dispatch to workflowId="${workflowId}"`);
      definition = this.loadWorkflow(workflowId);
    } else {
      // Find candidates by trigger type
      const candidates = this.findCandidates(triggerType);

      if (candidates.length === 0) {
        console.log(`[WorkflowRegistry] No workflows found for trigger type: ${triggerType}`);
        return null;
      }

      if (candidates.length === 1) {
        console.log(`[WorkflowRegistry] Single candidate found: "${candidates[0].definition.name}" (${candidates[0].definition.id})`);
        definition = candidates[0].definition;
      } else {
        // Multiple candidates — use LLM to select
        console.log(`[WorkflowRegistry] ${candidates.length} candidates found, using LLM to select`);
        const selected = await this.selectWorkflow(candidates, message);
        if (!selected) {
          console.log(`[WorkflowRegistry] LLM could not select a workflow for: "${message.slice(0, 100)}"`);
          return null;
        }
        definition = selected;
      }
    }

    // Create and start the executor
    console.log(`[WorkflowRegistry] Creating WorkflowExecutor for "${definition.name}" (${definition.id}), originChannel="${options.originChannel}"`);
    const executor = new WorkflowExecutor(definition, message, { emitEvent, originChannel: options.originChannel });

    console.log(`[WorkflowRegistry] Dispatching to workflow "${definition.name}" (${definition.id}) via ${triggerType}, executionId=${executor.id}`);

    // Run in background
    executor.execute().catch(err => {
      console.error(`[WorkflowRegistry] Workflow "${definition.id}" failed:`, err);
    });

    return {
      executionId:  executor.id,
      workflowId:   definition.id,
      workflowName: definition.name,
      executor,
    };
  }

  /**
   * Find all workflows that have a trigger node matching the given type.
   */
  findCandidates(triggerType: TriggerNodeSubtype): WorkflowCandidate[] {
    const candidates: WorkflowCandidate[] = [];

    console.log(`[WorkflowRegistry] findCandidates() — looking for triggerType="${triggerType}" in dir="${this.workflowsDir}"`);

    if (!fs.existsSync(this.workflowsDir)) {
      console.log(`[WorkflowRegistry] Workflows dir does not exist: ${this.workflowsDir}`);
      return candidates;
    }

    const entries = fs.readdirSync(this.workflowsDir, { withFileTypes: true });
    console.log(`[WorkflowRegistry] Found ${entries.length} entries in workflows dir`);

    for (const entry of entries) {
      if (!entry.isFile() || !(entry.name.endsWith('.yaml') || entry.name.endsWith('.json'))) continue;

      try {
        const filePath = path.join(this.workflowsDir, entry.name);
        const raw = fs.readFileSync(filePath, 'utf-8');
        const definition: WorkflowDefinition = entry.name.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);

        console.log(`[WorkflowRegistry] Scanning "${entry.name}": name="${definition.name}", enabled=${definition.enabled}`);

        // Only consider enabled workflows for production dispatch
        if (!definition.enabled) {
          console.log(`[WorkflowRegistry]   → Skipped (disabled)`);
          continue;
        }

        // Find trigger nodes matching this type
        let matched = false;
        for (const node of definition.nodes) {
          if (node.data.category === 'trigger') {
            console.log(`[WorkflowRegistry]   → Trigger node found: subtype="${node.data.subtype}", looking for="${triggerType}", match=${node.data.subtype === triggerType}`);
          }
          if (
            node.data.category === 'trigger' &&
            node.data.subtype === triggerType
          ) {
            candidates.push({
              definition,
              triggerDescription: (node.data.config?.triggerDescription as string) || definition.name || '',
            });
            matched = true;
            break; // one match per workflow is enough
          }
        }
        if (!matched) {
          console.log(`[WorkflowRegistry]   → No matching trigger for "${triggerType}"`);
        }
      } catch (err) {
        console.warn(`[WorkflowRegistry] Failed to parse ${entry.name}:`, err);
      }
    }

    console.log(`[WorkflowRegistry] findCandidates() result: ${candidates.length} candidate(s)`);
    return candidates;
  }

  /**
   * Use LLM to select the best workflow for a given message.
   */
  private async selectWorkflow(
    candidates: WorkflowCandidate[],
    message: string,
  ): Promise<WorkflowDefinition | null> {
    const { getLLMService } = await import('@pkg/agent/languagemodels');
    const llm = await getLLMService('remote');

    const workflowList = candidates
      .map((c, i) => `${i + 1}. "${c.definition.name}": ${c.triggerDescription}`)
      .join('\n');

    const systemPrompt = `You are a workflow router. Given a user message, select which workflow should handle it.
Respond with ONLY the number (1, 2, 3, etc.) of the best matching workflow. If none are a good match, respond with "0".

Available workflows:
${workflowList}`;

    const response = await llm.chat([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: message },
    ]);

    const rawContent = typeof response === 'string' ? response : (response?.content ?? '');
    const selected = parseInt(rawContent.trim(), 10);

    if (selected > 0 && selected <= candidates.length) {
      return candidates[selected - 1].definition;
    }

    return null;
  }

  /**
   * Load a specific workflow by ID.
   */
  private loadWorkflow(workflowId: string): WorkflowDefinition {
    const yamlPath = path.join(this.workflowsDir, `${workflowId}.yaml`);

    if (fs.existsSync(yamlPath)) {
      return yaml.parse(fs.readFileSync(yamlPath, 'utf-8'));
    }

    const jsonPath = path.join(this.workflowsDir, `${workflowId}.json`);

    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
    }

    throw new Error(`Workflow not found: ${workflowId}`);
  }
}

// ── Singleton ──

let instance: WorkflowRegistry | null = null;

export function getWorkflowRegistry(): WorkflowRegistry {
  if (!instance) {
    const { resolveSullaWorkflowsDir } = require('@pkg/agent/utils/sullaPaths');
    instance = new WorkflowRegistry(resolveSullaWorkflowsDir());
  }
  return instance;
}
