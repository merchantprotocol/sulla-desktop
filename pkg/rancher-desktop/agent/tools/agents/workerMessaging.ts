import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';

const CHECKIN_GUIDANCE = `[Worker check-ins]
Call report_progress at each meaningful milestone and at least every ~5 minutes while working. Include blockers immediately. Check every new turn for blocks labelled "Message from orchestrator" and treat them as new direction for the current task.`;

function representedMessageIds(state: any): Set<string> {
  return new Set((state?.messages ?? [])
    .map((message: any) => message?.metadata?.jobMessageId)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0));
}

/** Add worker guidance and durable queued messages at a CLI model-call boundary. */
export async function prepareWorkerTurnPrompt(state: any, basePrompt: string): Promise<string> {
  if (!state?.metadata?.isSubAgent) return basePrompt;
  const threadId = typeof state.metadata.threadId === 'string' ? state.metadata.threadId : '';
  if (!threadId) return `${ CHECKIN_GUIDANCE }\n\n${ basePrompt }`;

  let pending: Awaited<ReturnType<typeof AgentJobMessagingModel.pendingMessagesForThread>>;
  try {
    pending = await AgentJobMessagingModel.pendingMessagesForThread(threadId);
  } catch (err) {
    console.warn('[workerMessaging] queued-message read failed; continuing worker turn:', (err as Error).message);
    return `${ CHECKIN_GUIDANCE }\n\n${ basePrompt }`;
  }
  const represented = representedMessageIds(state);
  const fresh = pending.filter(message => !represented.has(message.id));

  if (pending.length > 0) {
    try {
      await AgentJobMessagingModel.markMessagesDelivered(pending.map(message => message.id), threadId);
    } catch (err) {
      console.warn('[workerMessaging] delivery receipt write failed; continuing worker turn:', (err as Error).message);
    }
  }

  const orchestratorMessages = fresh.map(message =>
    `[Message from orchestrator]\n${ message.message }`,
  ).join('\n\n');

  return [CHECKIN_GUIDANCE, orchestratorMessages, basePrompt].filter(Boolean).join('\n\n');
}

export { CHECKIN_GUIDANCE };
