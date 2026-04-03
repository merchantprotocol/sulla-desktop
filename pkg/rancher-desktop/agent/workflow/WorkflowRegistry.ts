/**
 * WorkflowRegistry — routes incoming messages to the right workflow.
 *
 * External trigger sources (calendar, chat apps, desktop, API) call the registry
 * with a trigger type and a user message. The registry:
 *
 * 1. Scans all saved workflows for trigger nodes matching that type
 * 2. If one match → returns it directly
 * 3. If multiple matches → uses LLM to pick the best one based on triggerDescription
 * 4. Can also be called with a specific workflowId to skip selection
 *
 * The registry does NOT execute workflows — it only selects them. Execution is
 * handled by the agent's graph loop via WorkflowPlaybook.
 */

import * as fs from 'fs';
import * as path from 'path';

import yaml from 'yaml';

import type {
  WorkflowDefinition,
  TriggerNodeSubtype,
} from '@pkg/pages/editor/workflow/types';

// ── Types ──

export interface WorkflowDispatchOptions {
  /** The trigger type (e.g. 'calendar', 'chat-app', 'sulla-desktop') */
  triggerType: TriggerNodeSubtype;
  /** The user message or payload that triggered this */
  message:     string;
  /** Optional: skip LLM selection and run this specific workflow */
  workflowId?: string;
}

export interface WorkflowDispatchResult {
  workflowId:   string;
  workflowName: string;
  definition:   WorkflowDefinition;
}

interface WorkflowCandidate {
  definition:         WorkflowDefinition;
  triggerDescription: string;
}

// ── Registry ──

export class WorkflowRegistry {
  private workflowsDirs: string[];

  constructor(workflowsDirs: string | string[]) {
    this.workflowsDirs = Array.isArray(workflowsDirs) ? workflowsDirs : [workflowsDirs];
  }

  /**
   * Select the appropriate workflow for a message.
   * Returns the workflow definition so callers can activate it via the playbook.
   */
  async dispatch(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult | null> {
    const { triggerType, message, workflowId } = options;

    console.log(`[WorkflowRegistry] dispatch() called — triggerType="${ triggerType }", workflowId="${ workflowId || '(auto)' }", message="${ message.slice(0, 80) }"`);

    let definition: WorkflowDefinition;

    if (workflowId) {
      console.log(`[WorkflowRegistry] Direct dispatch to workflowId="${ workflowId }"`);
      definition = this.loadWorkflow(workflowId);
    } else {
      const candidates = this.findCandidates(triggerType);

      if (candidates.length === 0) {
        console.log(`[WorkflowRegistry] No workflows found for trigger type: ${ triggerType }`);
        return null;
      }

      if (candidates.length === 1) {
        console.log(`[WorkflowRegistry] Single candidate found: "${ candidates[0].definition.name }" (${ candidates[0].definition.id })`);
        definition = candidates[0].definition;
      } else {
        console.log(`[WorkflowRegistry] ${ candidates.length } candidates found, using LLM to select`);
        const selected = await this.selectWorkflow(candidates, message);
        if (!selected) {
          console.log(`[WorkflowRegistry] LLM could not select a workflow for: "${ message.slice(0, 100) }"`);
          return null;
        }
        definition = selected;
      }
    }

    console.log(`[WorkflowRegistry] Selected workflow "${ definition.name }" (${ definition.id }) via ${ triggerType }`);

    return {
      workflowId:   definition.id,
      workflowName: definition.name,
      definition,
    };
  }

  /**
   * Find all workflows that have a trigger node matching the given type.
   */
  findCandidates(triggerType: TriggerNodeSubtype): WorkflowCandidate[] {
    const candidates: WorkflowCandidate[] = [];
    const seenIds = new Set<string>();

    console.log(`[WorkflowRegistry] findCandidates() — looking for triggerType="${ triggerType }" in dirs=${ JSON.stringify(this.workflowsDirs) }`);

    for (const workflowsDir of this.workflowsDirs) {
      if (!fs.existsSync(workflowsDir)) {
        console.log(`[WorkflowRegistry] Workflows dir does not exist: ${ workflowsDir }`);
        continue;
      }

      const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });
      console.log(`[WorkflowRegistry] Found ${ entries.length } entries in ${ workflowsDir }`);

      for (const entry of entries) {
        if (!entry.isFile() || !(entry.name.endsWith('.yaml') || entry.name.endsWith('.json'))) continue;

        try {
          const filePath = path.join(workflowsDir, entry.name);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const definition: WorkflowDefinition = entry.name.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);

          // Attach slug derived from filename — this is what the LLM uses to reference workflows
          const fileSlug = entry.name.replace(/\.(yaml|json)$/, '');
          (definition as any)._slug = (definition as any).slug || fileSlug;

          // Skip duplicates — user workflows (later dirs) override native ones
          const id = definition.id || fileSlug;
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          console.log(`[WorkflowRegistry] Scanning "${ entry.name }": name="${ definition.name }", slug="${ (definition as any)._slug }"`);

          let matched = false;
          for (const node of definition.nodes) {
            if (node.data.category === 'trigger') {
              console.log(`[WorkflowRegistry]   → Trigger node found: subtype="${ node.data.subtype }", looking for="${ triggerType }", match=${ node.data.subtype === triggerType }`);
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
              break;
            }
          }
          if (!matched) {
            console.log(`[WorkflowRegistry]   → No matching trigger for "${ triggerType }"`);
          }
        } catch (err) {
          console.warn(`[WorkflowRegistry] Failed to parse ${ entry.name }:`, err);
        }
      }
    }

    console.log(`[WorkflowRegistry] findCandidates() result: ${ candidates.length } candidate(s)`);
    return candidates;
  }

  /**
   * Load a specific workflow by ID (scans files since filenames are name-slugs, not IDs).
   */
  loadWorkflow(workflowId: string): WorkflowDefinition {
    const needle = workflowId.toLowerCase();

    for (const workflowsDir of this.workflowsDirs) {
      if (!fs.existsSync(workflowsDir)) continue;

      const entries = fs.readdirSync(workflowsDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !(entry.name.endsWith('.yaml') || entry.name.endsWith('.json'))) continue;
        try {
          const filePath = path.join(workflowsDir, entry.name);
          const raw = fs.readFileSync(filePath, 'utf-8');
          const parsed: WorkflowDefinition = entry.name.endsWith('.json') ? JSON.parse(raw) : yaml.parse(raw);

          // Match by slug or filename (without extension) — never expose raw IDs to the LLM
          const fileBaseName = entry.name.replace(/\.(yaml|json)$/, '');
          (parsed as any)._slug = (parsed as any).slug || fileBaseName;

          if (
            ((parsed as any).slug && (parsed as any).slug.toLowerCase() === needle) ||
            fileBaseName.toLowerCase() === needle ||
            parsed.id === workflowId
          ) {
            return parsed;
          }
        } catch { /* skip unparseable files */ }
      }
    }

    throw new Error(`Workflow not found: ${ workflowId }`);
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
      .map((c, i) => `${ i + 1 }. "${ c.definition.name }": ${ c.triggerDescription }`)
      .join('\n');

    const systemPrompt = `You are a workflow router. Given a user message, select which workflow should handle it.
Respond with ONLY the number (1, 2, 3, etc.) of the best matching workflow. If none are a good match, respond with "0".

Available workflows:
${ workflowList }`;

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
}

// ── Singleton ──

let instance: WorkflowRegistry | null = null;

export function getWorkflowRegistry(): WorkflowRegistry {
  if (!instance) {
    const { resolveAllWorkflowsProductionDirs } = require('@pkg/agent/utils/sullaPaths');
    instance = new WorkflowRegistry(resolveAllWorkflowsProductionDirs());
  }
  return instance;
}
