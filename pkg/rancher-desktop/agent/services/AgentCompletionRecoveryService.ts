import { getWebSocketClientService } from './WebSocketClientService';
import { getPendingCompletions, markCompletionDelivered, type AgentJob } from '../tools/agents/jobRegistry';

let recoveryPromise: Promise<void> | null = null;
const inFlight = new Set<string>();

function wakeContent(job: AgentJob): string {
  const formatted = job.results.map(result =>
    `### ${ result.label } [${ result.status.toUpperCase() }]\n${ result.output }`,
  ).join('\n\n---\n\n');
  return `[sub-agent job ${ job.jobId } complete — ${ job.results.length } result(s)]\n\n` +
    'These are the durable results returned by the background sub-agent(s). ' +
    'Continue your orchestration using them (do NOT call check_agent_jobs for this job):\n\n' +
    formatted;
}

/**
 * Re-deliver completed graph-owned sub-agent reports after process recovery.
 * Delivery is idempotent at the job level and remains pending if the message
 * bus is unavailable, so a later boot can retry it.
 */
export async function recoverPendingAgentCompletions(): Promise<void> {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = (async() => {
    const jobs = await getPendingCompletions();
    for (const job of jobs) {
      if (inFlight.has(job.jobId) || !job.parentChannel || !job.parentThreadId) continue;
      inFlight.add(job.jobId);
      try {
        const ws = getWebSocketClientService();
        await ws.send(job.parentChannel, {
          type: 'user_message',
          data: {
            content: wakeContent(job),
            threadId: job.parentThreadId,
            metadata: {
              source: 'sub_agent_completion',
              origin: 'spawn_agent_recovery',
              inputSource: 'system',
              jobId: job.jobId,
              recovered: true,
            },
          },
        });
        await markCompletionDelivered(job.jobId);
      } catch (error) {
        console.warn(`[AgentCompletionRecovery] delivery failed for ${ job.jobId }; will retry:`, error);
      } finally {
        inFlight.delete(job.jobId);
      }
    }
  })().finally(() => {
    recoveryPromise = null;
  });
  return recoveryPromise;
}
