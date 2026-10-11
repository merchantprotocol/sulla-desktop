import { randomUUID } from 'node:crypto';

import { latestUserText } from '../../utils/latestUserText';
import { postgresClient } from '../PostgresClient';

export type AgentDelegationVia = 'spawn_agent' | 'agent_tab';
export type AgentDelegationOutcome = 'completed' | 'failed' | 'rejected';

export interface AgentDelegationStart {
  via:             AgentDelegationVia;
  parentAgentId:   string;
  parentThreadId?: string | null;
  childAgentId:    string;
  childThreadId?:  string | null;
  /** spawn_agent job id or agent-tab contract id. */
  refId?:          string | null;
  /** Projects task the call carried, if any. Never guessed. */
  taskId?:         string | null;
  situation?:      string;
  brief?:          string;
}

export interface AgentDelegationFinish {
  outcome:          AgentDelegationOutcome;
  detail?:          string;
  /** True when the result was handed back into the parent's loop. */
  resultDelivered?: boolean | null;
}

const SITUATION_CHARS = 1000;
const BRIEF_CHARS = 2000;
const DETAIL_CHARS = 1000;

const clip = (text: string | undefined, max: number) => String(text ?? '').slice(0, max);

/**
 * Delegation outcome log (agent_delegations): one row per hand-off from one
 * agent to another. Training data for routing. Every write is best-effort —
 * a logging failure must never break or slow a delegation, so callers use the
 * safe* helpers below.
 */
export class AgentDelegationModel {
  static async start(input: AgentDelegationStart): Promise<string> {
    const id = `delegation-${ randomUUID() }`;
    await postgresClient.query(`
      INSERT INTO agent_delegations (
        id, via, parent_agent_id, parent_thread_id, child_agent_id, child_thread_id,
        ref_id, task_id, situation, brief
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    `, [
      id, input.via, input.parentAgentId || '', input.parentThreadId ?? null, input.childAgentId,
      input.childThreadId ?? null, input.refId ?? null, input.taskId ?? null,
      clip(input.situation, SITUATION_CHARS), clip(input.brief, BRIEF_CHARS),
    ]);
    return id;
  }

  static async finish(id: string, input: AgentDelegationFinish): Promise<void> {
    await postgresClient.query(`
      UPDATE agent_delegations
         SET finished_at = now(), outcome = $2, outcome_detail = $3,
             result_delivered = COALESCE($4, result_delivered)
       WHERE id = $1
    `, [id, input.outcome, clip(input.detail, DETAIL_CHARS), input.resultDelivered ?? null]);
  }

  /** Finish the open delegation for a ref (e.g. an agent-tab contract id). */
  static async finishByRef(refId: string, input: AgentDelegationFinish): Promise<void> {
    await postgresClient.query(`
      UPDATE agent_delegations
         SET finished_at = now(), outcome = $2, outcome_detail = $3,
             result_delivered = COALESCE($4, result_delivered)
       WHERE ref_id = $1 AND finished_at IS NULL
    `, [refId, input.outcome, clip(input.detail, DETAIL_CHARS), input.resultDelivered ?? null]);
  }

  static async markDelivered(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await postgresClient.query('UPDATE agent_delegations SET result_delivered = true WHERE id = ANY($1::text[])', [ids]);
  }

  /** A delegation the system refused before it launched. */
  static async reject(input: AgentDelegationStart, detail: string): Promise<void> {
    const id = await AgentDelegationModel.start(input);
    await AgentDelegationModel.finish(id, { outcome: 'rejected', detail, resultDelivered: false });
  }
}

function warn(action: string, err: unknown): void {
  console.warn(`[AgentDelegationLog] ${ action } failed:`, err instanceof Error ? err.message : err);
}

export async function safeStartDelegation(input: AgentDelegationStart): Promise<string | null> {
  try { return await AgentDelegationModel.start(input) } catch (err) { warn('start', err); return null }
}

export async function safeFinishDelegation(id: string | null | undefined, input: AgentDelegationFinish): Promise<void> {
  if (!id) return;
  try { await AgentDelegationModel.finish(id, input) } catch (err) { warn('finish', err) }
}

export async function safeFinishDelegationByRef(refId: string, input: AgentDelegationFinish): Promise<void> {
  try { await AgentDelegationModel.finishByRef(refId, input) } catch (err) { warn('finish', err) }
}

export async function safeMarkDelegationsDelivered(ids: (string | null | undefined)[]): Promise<void> {
  try { await AgentDelegationModel.markDelivered(ids.filter((id): id is string => !!id)) } catch (err) { warn('deliver', err) }
}

export async function safeRejectDelegation(input: AgentDelegationStart, detail: string): Promise<void> {
  try { await AgentDelegationModel.reject(input, detail) } catch (err) { warn('reject', err) }
}

/**
 * The situation a delegation was made in: the parent's latest real user-role
 * message (a human turn or a sub-agent result wake).
 */
export function delegationSituation(messages: any[] | undefined): string {
  return latestUserText(messages, SITUATION_CHARS);
}

/** A Projects task id the call or its parent already carries. Never invented. */
export function delegationTaskId(explicit: unknown, metadata: any): string | null {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const owned = Array.isArray(metadata?.ownedProjectTaskIds)
    ? metadata.ownedProjectTaskIds.filter((id: unknown) => typeof id === 'string' && id)
    : [];
  return owned.length === 1 ? owned[0] : null;
}
