import { getWebSocketClientService } from './WebSocketClientService';
import { buildWakeContent } from '../tools/agents/jobDelivery';
import { getPendingCompletions, markCompletionDelivered } from '../tools/agents/jobRegistry';

let recoveryPromise: Promise<void> | null = null;
const inFlight = new Set<string>();

/**
 * Re-deliver completed delegation results (hidden or tab) after process
 * recovery, in the same wake format as the live delivery path.
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
            content: buildWakeContent(job.jobId, job.results),
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
