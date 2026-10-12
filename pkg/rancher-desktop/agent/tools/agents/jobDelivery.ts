/**
 * One delivery path for every delegation result, hidden or tabbed: the same
 * wake message into the parent's graph, the same proactive card, and the same
 * "delivered" mark once the wake went out. Undelivered completions stay
 * pending in agent_jobs and AgentCompletionRecoveryService re-sends them.
 */

import { getWebSocketClientService } from '../../services/WebSocketClientService';
import { contractResultOutput, contractReturnStatus, normalizeContract } from './contract';
import { markCompletionDelivered } from './jobRegistry';

import type { AgentJobResult, AgentJobTask } from './jobRegistry';

/** A returned contract as the job result the parent reads. */
export function returnedJobResult(task: AgentJobTask, label: string, threadId: string): AgentJobResult {
  const contract = task.contract ?? normalizeContract(undefined);
  const status = contractReturnStatus(contract, task.result);
  return {
    label,
    status:   status === 'failed' ? 'error' : status,
    output:   contractResultOutput(contract, task.result, task.summary),
    threadId,
    contract: contract.name,
    result:   task.result,
  };
}

/** One result as the orchestrator reads it. */
export function formatJobResult(r: AgentJobResult): string {
  const contract = r.contract && r.contract !== 'result' ? ` · contract ${ r.contract }` : '';
  return `### ${ r.label } [${ r.status.toUpperCase() }]${ contract }\n${ r.output }`;
}

/** Format the finished job as an orchestrator-facing input message. */
export function buildWakeContent(
  jobId: string,
  results: AgentJobResult[],
  failureReason?: string,
): string {
  if (failureReason) {
    return `[sub-agent job ${ jobId } FAILED] ${ failureReason }\n\n` +
      'Your background sub-agent(s) errored before returning results. Decide how to proceed (retry, adjust, or report back).';
  }

  const formatted = results.map(formatJobResult).join('\n\n---\n\n');

  return `[sub-agent job ${ jobId } complete — ${ results.length } result(s)]\n\n` +
    'These are the results returned by the sub-agent(s) you launched. ' +
    'Continue your orchestration using them (do NOT call check_agent_jobs for this job — the results are below):\n\n' +
    formatted;
}

// ─── Parent-graph wake ───────────────────────────────────────────
// Re-enters the orchestrator's own graph loop with the finished sub-agent
// results as input. The proactive card (below) is display-only — the
// MessageDispatcher 'proactive' handler pushes it to the message list WITHOUT
// calling graph.execute(), so on its own it never wakes the orchestrator.
//
// This sends a `user_message` on the parent channel + thread, which loops back
// through getWebSocketClientService() into BackendGraphWebSocketService and
// runs a fresh turn on the SAME thread (the exact primitive the inter-agent
// `<channel:x wake>` tag uses).
//
// No-op when there is no parent thread to resume (falls back to card-only).
export async function wakeParentGraph(
  parentChannel: string,
  parentThreadId: string | undefined,
  jobId: string,
  results: AgentJobResult[],
  failureReason?: string,
): Promise<boolean> {
  if (!parentThreadId) return false;

  try {
    const ws = getWebSocketClientService();
    const content = buildWakeContent(jobId, results, failureReason);

    await ws.send(parentChannel, {
      type: 'user_message',
      data: {
        content,
        threadId: parentThreadId,
        metadata: {
          // Marks this as a background-completion wake rather than human input,
          // so downstream nodes/telemetry can tell it apart from typed messages.
          source:      'sub_agent_completion',
          origin:      'spawn_agent',
          inputSource: 'system',
          jobId,
        },
      },
    });
    console.log(`[jobDelivery] Woke parent graph — channel="${ parentChannel }" thread="${ parentThreadId.slice(-8) }" job=${ jobId }`);
    return true;
  } catch (e) {
    console.warn('[jobDelivery] wakeParentGraph failed:', e);
    return false;
  }
}

// ─── Proactive completion card ───────────────────────────────────
// A user-facing heads-up in the parent chat that delegated work settled. The
// parent graph is woken separately with the full results.
export async function emitProactiveCompletion(
  parentChannel: string,
  jobId: string,
  results: AgentJobResult[],
  failureReason?: string,
  parentThreadId?: string,
): Promise<void> {
  try {
    const ws = getWebSocketClientService();

    let headline: string;
    let body: string;
    if (failureReason) {
      headline = 'Background agents failed';
      body = `Job ${ jobId } errored: ${ failureReason.slice(0, 200) }`;
    } else {
      const done = results.filter(r => r.status === 'completed').length;
      const blocked = results.filter(r => r.status === 'blocked').length;
      const errored = results.filter(r => r.status === 'error').length;
      const labels = results.map(r => r.label).slice(0, 3).join(', ');
      headline = errored > 0 || blocked > 0
        ? `Background agents finished — ${ done } done, ${ blocked } blocked, ${ errored } failed`
        : `Background agents finished — ${ done }/${ results.length } complete`;
      body = results.length === 1
        ? `Task "${ results[0].label }" is ready. Check \`check_agent_jobs("${ jobId }")\` for the full result.`
        : `Tasks: ${ labels }${ results.length > 3 ? `, +${ results.length - 3 } more` : '' }. Check \`check_agent_jobs("${ jobId }")\` for results.`;
    }

    ws.send(parentChannel, {
      type: 'chat_message',
      data: {
        ...(parentThreadId ? { threadId: parentThreadId } : {}),
        kind: 'proactive',
        role: 'assistant',
        headline,
        body,
        content: body,
      },
    });
  } catch (e) {
    console.warn('[jobDelivery] proactive emit failed:', e);
  }
}

/**
 * Card + wake for a settled job, then the durable delivered mark. Returns
 * whether the wake went out; a false return leaves the completion pending
 * for the recovery pass.
 */
export async function deliverJobCompletion(job: {
  jobId:           string;
  parentChannel?:  string;
  parentThreadId?: string;
}, results: AgentJobResult[]): Promise<boolean> {
  const channel = job.parentChannel || 'sulla-desktop';
  await emitProactiveCompletion(channel, job.jobId, results, undefined, job.parentThreadId);
  const delivered = await wakeParentGraph(channel, job.parentThreadId, job.jobId, results);
  if (delivered) await markCompletionDelivered(job.jobId);
  return delivered;
}
