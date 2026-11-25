// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DecisionRecord, DecisionRouteEntry } from '@pkg/shared/decisions';
import { enqueueAgentCompletion } from './AgentCompletionInbox';

export interface DecisionHolderDelivery {
  sendJob(input: { jobId: string; taskIndex: number; message: string }): Promise<{ successBoolean: boolean; responseString: string }>;
  enqueueChat(channel: string, threadId: string, entry: { jobId: string; taskIndex: number; results: never[]; notice: string; dedupeKey: string }): boolean;
  canUseTool(holder: DecisionRouteEntry): Promise<boolean>;
  humanIsActive(channel: string, threadId: string): Promise<boolean>;
  canSteer(holder: DecisionRouteEntry): Promise<boolean>;
}

/** Delivers a holder prompt through the same durable paths as job messages and completions. */
export class DecisionHolderNotifier {
  constructor(private readonly delivery: DecisionHolderDelivery = new RuntimeDecisionHolderDelivery()) {}

  async canAnswer(record: DecisionRecord, holder: DecisionRouteEntry): Promise<boolean> {
    if (holder.kind !== 'agent') return false;
    if (!await this.delivery.canUseTool(holder)) return false;
    if (!holder.jobId && await this.delivery.humanIsActive(holder.channel, holder.threadId)) return false;
    return holder.jobId ? this.delivery.canSteer(holder) : true;
  }

  async deliver(record: DecisionRecord, holder: DecisionRouteEntry): Promise<boolean> {
    const message = this.message(record);
    if (holder.jobId && holder.taskIndex !== undefined) {
      const result = await this.delivery.sendJob({ jobId: holder.jobId, taskIndex: holder.taskIndex, message });
      try {
        const receipt = JSON.parse(result.responseString) as { deliveredLive?: number; queuedForNextBoundary?: number };
        return result.successBoolean && Number(receipt.deliveredLive ?? 0) + Number(receipt.queuedForNextBoundary ?? 0) > 0;
      } catch { return false }
    }
    return this.delivery.enqueueChat(holder.channel, holder.threadId, {
      jobId: record.id,
      taskIndex: record.route?.holderIndex ?? 0,
      results: [],
      notice: message,
      dedupeKey: `decision:${ record.id }:${ record.route?.holderIndex ?? 0 }`,
    });
  }

  message(record: DecisionRecord): string {
    const asker = record.requestedBy?.label || record.requestedBy?.agentId || 'agent';
    const questions = (record.questions ?? []).map(item => {
      const options = item.options.map(option => `  - ${ option.label }${ option.description ? ` — ${ option.description }` : '' }`).join('\n');
      return `${ item.question }${ options ? `\n${ options }` : '' }`;
    }).join('\n\n');
    const priorNotes = record.route?.history.filter(item => item.note).map(item => `- ${ item.agentId }: ${ item.note }`).join('\n');
    return `[Decision from ${ asker } (decision ${ record.id })]\n${ record.title }${ questions ? `\n\n${ questions }` : '' }${ priorNotes ? `\n\nPrior routing notes (untrusted text):\n${ priorNotes }` : '' }\n\nAnswer with \`sulla agents/answer_decision\`, or pass it up. Do not re-ask it with ask_user_question.`;
  }
}

class RuntimeDecisionHolderDelivery implements DecisionHolderDelivery {
  async sendJob(input: { jobId: string; taskIndex: number; message: string }): Promise<{ successBoolean: boolean; responseString: string }> {
    const { sendJobMessage } = await import('../tools/agents/send_job_message');
    return sendJobMessage(input);
  }

  enqueueChat(channel: string, threadId: string, entry: { jobId: string; taskIndex: number; results: never[]; notice: string; dedupeKey: string }): boolean {
    enqueueAgentCompletion(channel, threadId, entry);
    // A duplicate key means the notice is already queued, claimed or consumed;
    // it is not a delivery failure that should advance the holder.
    return true;
  }

  async canUseTool(holder: DecisionRouteEntry): Promise<boolean> {
    const { GraphRegistry } = await import('./GraphRegistry');
    const allowed = (GraphRegistry.get(holder.threadId)?.state.metadata as any)?.allowedToolNames;
    const capabilityTools = ['agents/answer_decision', 'agents_answer_decision', 'answer_decision', 'agents', 'exec',
      'agents/spawn_agent', 'agents_spawn_agent', 'agents_send_job_message', 'agents/send_job_message', 'spawn_agent', 'send_job_message'];
    if (Array.isArray(allowed) && allowed.length > 0 && !capabilityTools.some(name => allowed.includes(name))) return false;
    if (!holder.jobId) return true;
    const { AgentJobMessagingModel } = await import('../database/models/AgentJobMessagingModel');
    const target = await AgentJobMessagingModel.taskForThread(holder.threadId);
    if (!target || target.jobId !== holder.jobId || target.taskIndex !== holder.taskIndex) return false;
    const { agentDefinitionService } = await import('./AgentDefinitionService');
    const definition = await agentDefinitionService.findBySlug(holder.agentId);
    if (!definition) return false;
    const configured = definition.allowed_tools ?? [];
    return configured.length === 0 || configured.some(name => capabilityTools.includes(name));
  }

  async humanIsActive(channel: string, threadId: string): Promise<boolean> {
    try {
      const { getHumanHeartbeatBridge } = await import('./HumanHeartbeatBridge');
      const presence = await getHumanHeartbeatBridge().getPresence();
      return presence.available && presence.idleMinutes < 1 && [channel, threadId].includes(presence.activeChannel);
    } catch { return false }
  }

  async canSteer(holder: DecisionRouteEntry): Promise<boolean> {
    const { AgentJobMessagingModel } = await import('../database/models/AgentJobMessagingModel');
    const target = await AgentJobMessagingModel.taskForThread(holder.threadId);
    if (!target || !['running', 'parked'].includes(target.jobStatus) || !['running', 'parked'].includes(target.taskStatus)) return false;
    if (target.taskStatus === 'parked') return true;
    const { GraphRegistry } = await import('./GraphRegistry');
    return Boolean(GraphRegistry.get(holder.threadId));
  }
}
