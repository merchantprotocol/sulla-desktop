/**
 * WorkflowRegistry — routes incoming messages to the right workflow.
 *
 * External trigger sources (calendar, chat apps, desktop, API) call the registry
 * with a trigger type and a user message. The registry:
 *
 *   1. Queries the `workflows` table for rows matching the trigger type
 *   2. If one match → returns it directly
 *   3. If multiple matches → uses LLM to pick the best one based on triggerDescription
 *   4. Can also be called with a specific workflowId to skip selection
 *
 * The registry does NOT execute workflows — it only selects them. Execution is
 * handled by the graph walker via WorkflowPlaybook.
 *
 * As of Phase 2, this reads exclusively from Postgres (WorkflowModel). The
 * previous YAML-scanning implementation is gone; `~/sulla/resources/workflows/`
 * and the user-home workflow dirs are no longer consulted.
 */

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

/**
 * Dynamic import of WorkflowModel — keeps the Postgres layer out of the
 * agent's startup bundle, matching the pattern used elsewhere.
 */
async function getModel() {
  const mod = await import('@pkg/agent/database/models/WorkflowModel');

  return mod.WorkflowModel;
}

/**
 * Extract the "definition" payload from a WorkflowModel row. Does a
 * little normalisation so downstream code (playbook controllers,
 * execute_workflow tool) sees a consistent shape regardless of what
 * was stored.
 */
function definitionFromModel(
  row: Awaited<ReturnType<Awaited<ReturnType<typeof getModel>>['findById']>>,
): WorkflowDefinition | null {
  if (!row) return null;
  const def = row.attributes.definition as WorkflowDefinition | undefined;
  if (!def) return null;

  // Slug lets the LLM reference workflows without exposing raw IDs.
  // Fall back to the row id if the definition doesn't carry a slug.
  const asAny = def as WorkflowDefinition & { slug?: string; _slug?: string };
  asAny._slug = asAny.slug ?? asAny._slug ?? row.attributes.id;

  return def;
}

// ── Registry ──

export class WorkflowRegistry {
  /**
   * Select the appropriate workflow for a message.
   * Returns the workflow definition so callers can activate it via the playbook.
   */
  async dispatch(options: WorkflowDispatchOptions): Promise<WorkflowDispatchResult | null> {
    const { triggerType, message, workflowId } = options;

    console.log(`[WorkflowRegistry] dispatch() triggerType="${ triggerType }", workflowId="${ workflowId || '(auto)' }", message="${ message.slice(0, 80) }"`);

    let definition: WorkflowDefinition | null = null;

    if (workflowId) {
      definition = await this.loadWorkflow(workflowId);
      if (!definition) {
        console.log(`[WorkflowRegistry] Direct dispatch failed — no workflow with id="${ workflowId }"`);

        return null;
      }
    } else {
      const candidates = await this.findCandidates(triggerType);

      if (candidates.length === 0) {
        console.log(`[WorkflowRegistry] No workflows found for trigger type: ${ triggerType }`);

        return null;
      }

      if (candidates.length === 1) {
        definition = candidates[0].definition;
      } else {
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
   * Find all production workflows that have a trigger node matching the given type.
   *
   * The filter is applied in-process after the list query — the trigger
   * node lives inside the `definition` JSONB, not in a dedicated column.
   * Numbers are small (tens of routines), so this is fine; if it grows
   * we can move the predicate into SQL via a jsonb_path_query.
   */
  async findCandidates(triggerType: TriggerNodeSubtype): Promise<WorkflowCandidate[]> {
    console.log(`[WorkflowRegistry] findCandidates() — looking for triggerType="${ triggerType }"`);

    const WorkflowModel = await getModel();
    const rows = await WorkflowModel.listByStatus('production');

    const candidates: WorkflowCandidate[] = [];

    for (const row of rows) {
      const definition = definitionFromModel(row);
      if (!definition) continue;

      const triggerNode = (definition.nodes ?? []).find(
        node => node.data?.category === 'trigger' && node.data?.subtype === triggerType,
      );
      if (!triggerNode) continue;

      candidates.push({
        definition,
        triggerDescription:
          (triggerNode.data.config?.triggerDescription as string) ||
          definition.name ||
          '',
      });
    }

    console.log(`[WorkflowRegistry] findCandidates() — ${ candidates.length } candidate(s)`);

    return candidates;
  }

  /**
   * Load a specific workflow by id. Returns null when no row exists so
   * callers can discriminate "not found" from a hard failure.
   *
   * Accepts both the canonical row id and a slug — when the caller
   * passes a slug (e.g. "daily-planning"), we list production rows and
   * match by `definition.slug` in-process.
   */
  async loadWorkflow(workflowId: string): Promise<WorkflowDefinition | null> {
    const WorkflowModel = await getModel();

    // Fast path: direct id match.
    const byId = await WorkflowModel.findById(workflowId);
    if (byId) return definitionFromModel(byId);

    // Slug fallback — the LLM speaks slugs, so resolve them against
    // production rows. Falls through to null when nothing matches.
    const needle = workflowId.toLowerCase();
    const productionRows = await WorkflowModel.listByStatus('production');

    for (const row of productionRows) {
      const def = definitionFromModel(row);
      if (!def) continue;
      const asAny = def as WorkflowDefinition & { slug?: string; _slug?: string };
      if (
        asAny.slug?.toLowerCase() === needle ||
        asAny._slug?.toLowerCase() === needle
      ) {
        return def;
      }
    }

    return null;
  }

  /**
   * Use the LLM to select the best workflow for a given message.
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
    instance = new WorkflowRegistry();
  }

  return instance;
}
