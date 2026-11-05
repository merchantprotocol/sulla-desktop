// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentJobMessagingModel } from '../../database/models/AgentJobMessagingModel';

const CHECKIN_GUIDANCE = `[Worker check-ins]
Call report_progress at each meaningful milestone and at least every ~5 minutes while working. Include blockers immediately. Check every new turn for blocks labelled "Message from orchestrator" and treat them as new direction for the current task.`;

/** Builds the short operational contract injected into every delegated turn. */
export class WorkerPromptBuilder {
  build(metadata: Record<string, unknown>): string {
    const jobId = String(metadata.delegatedJobId ?? metadata.jobId ?? 'unknown');
    const taskIndex = String(metadata.delegatedTaskIndex ?? metadata.taskIndex ?? 'unknown');
    const manager = String(metadata.managerAgentId ?? metadata.parentAgentId ?? metadata.workflowParentChannel ?? 'unknown');
    return `[How your job works]
Job: ${ jobId } (task ${ taskIndex })
Manager: ${ manager }
Ending your turn without agents/return_result fails your task after one reminder.
For anything longer than a minute, use sulla agents/wait with seconds and reason, then end your turn.
Never use background processes, Monitor, cron, or scheduled wakeups.
Manager messages arrive at your next tool boundary as "[Message from orchestrator]"; prefer short tool calls while waiting.
Put questions in report_progress blockers so your manager is alerted.`;
  }
}

const workerPromptBuilder = new WorkerPromptBuilder();

function representedMessageIds(state: any): Set<string> {
  return new Set((state?.messages ?? [])
    .map((message: any) => message?.metadata?.jobMessageId)
    .filter((id: unknown): id is string => typeof id === 'string' && id.length > 0));
}

/** Add worker guidance and durable queued messages at a CLI model-call boundary. */
export async function prepareWorkerTurnPrompt(state: any, basePrompt: string): Promise<string> {
  if (!state?.metadata?.isSubAgent) return basePrompt;
  const workerGuidance = workerPromptBuilder.build(state.metadata);
  const threadId = typeof state.metadata.threadId === 'string' ? state.metadata.threadId : '';
  if (!threadId) return `${ CHECKIN_GUIDANCE }\n\n${ workerGuidance }\n\n${ basePrompt }`;

  let pending: Awaited<ReturnType<typeof AgentJobMessagingModel.pendingMessagesForThread>>;
  try {
    pending = await AgentJobMessagingModel.pendingMessagesForThread(threadId);
  } catch (err) {
    console.warn('[workerMessaging] queued-message read failed; continuing worker turn:', (err as Error).message);
    return `${ CHECKIN_GUIDANCE }\n\n${ workerGuidance }\n\n${ basePrompt }`;
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

  return [CHECKIN_GUIDANCE, workerGuidance, orchestratorMessages, basePrompt].filter(Boolean).join('\n\n');
}

export { CHECKIN_GUIDANCE };
