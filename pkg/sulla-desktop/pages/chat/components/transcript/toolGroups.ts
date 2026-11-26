// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatToolReporting } from '@pkg/agent/tools/ChatToolReporting';
import type { AgentResultItem } from '@pkg/shared/agentResults/AgentResultCard';

import { LegacyAgentNotices } from '../../messages/legacyAgentNotice';
import { A2aCardMarkup } from '../../messages/a2aCardMarkup';
import type { Message } from '../../models/Message';
import type { ReportingLevel } from '../../models/ReportingLevel';

export type CardMessage = Exclude<Message, { kind: 'thinking' | 'tool' }>;
type Classification = { label: string; level: ReportingLevel; essential?: true };
type EntryBase = Classification & { id: string; sourceId: string; createdAt: number };
export type TranscriptEntry =
  | (EntryBase & { kind: 'card'; message: CardMessage })
  | (EntryBase & { kind: 'activity'; text: string });

const rank: Record<ReportingLevel, number> = { fatal: 0, info: 1, debug: 2 };

const cards: Record<CardMessage['kind'], Classification> = {
  user:              { label: 'Message', level: 'info', essential: true },
  sulla:             { label: 'Reply', level: 'info', essential: true },
  html:              { label: 'Reply', level: 'info', essential: true },
  streaming:         { label: 'Reply', level: 'info', essential: true },
  tool_approval:     { label: 'Approval', level: 'info', essential: true },
  tool_question:     { label: 'Question', level: 'info', essential: true },
  patch:             { label: 'Change', level: 'info' },
  channel:           { label: 'Agent message', level: 'debug' },
  subagent:          { label: 'Agent status', level: 'info' },
  subagent_exchange: { label: 'Handoff', level: 'info' },
  citation:          { label: 'Evidence', level: 'info' },
  memory:            { label: 'Memory', level: 'debug' },
  proactive:         { label: 'Update', level: 'info', essential: true },
  heartbeat:         { label: 'Heartbeat', level: 'debug' },
  tts:               { label: 'Voice', level: 'info', essential: true },
  interim:           { label: 'Voice', level: 'info', essential: true },
  error:             { label: 'Error', level: 'fatal' },
  notice:            { label: 'Notice', level: 'info' },
  inline_file_reference: { label: 'File', level: 'info', essential: true },
};

const toolStatuses = new Map([['running', 'Running'], ['ok', 'Completed'], ['error', 'Failed']]);
// Standard view retains the established friendly labels; Detailed view uses
// recorded tool names and full payloads instead of this presentation map.
const toolLabels = new Map([
  ['Agents', 'Agents'], ['Bash', 'Shell'], ['Bridge', 'Bridge'], ['Browser', 'Browser'],
  ['Calendar', 'Calendar'], ['Database', 'Database'], ['Docker', 'Docker'], ['Extensions', 'Extensions'],
  ['File', 'File'], ['Git', 'Git'], ['GitHub', 'GitHub'], ['Host', 'Host'], ['Memory', 'Memory'],
  ['Integrations', 'Integrations'], ['Redis', 'Redis'], ['Search', 'Search'], ['Skills', 'Skills'],
  ['Slack', 'Slack'], ['Vault', 'Vault'], ['Workflow', 'Workflow'], ['Workspace', 'Workspace'],
]);

export class TranscriptReporting {
  constructor(private readonly agentMessages = new A2aCardMarkup()) {}

  /** Project one active thread, never reorder or change its retained messages. */
  entries(messages: readonly Message[], level: ReportingLevel, needsHumanDecision?: (item: AgentResultItem) => boolean): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      for (const entry of this.project(message, level, needsHumanDecision)) {
        if (entry.essential || rank[entry.level] <= rank[level]) entries.push(entry);
      }
    }
    return entries;
  }

  /** Stable Standard projection shared by Standard and Detailed; Brief remains filtered. */
  standardEntries(messages: readonly Message[], level: ReportingLevel, needsHumanDecision?: (item: AgentResultItem) => boolean): TranscriptEntry[] {
    return this.entries(messages, level === 'fatal' ? 'fatal' : 'info', needsHumanDecision);
  }

  /** Insert a paragraph gap before streamed text only when its nearest text
   * segment belongs to the same reply stream. Activity rows are transparent;
   * other cards are a substantive boundary and must stop the continuation. */
  isStreamingContinuation(entries: readonly TranscriptEntry[], index: number): boolean {
    const entry = entries[index];
    if (entry?.kind !== 'card' || entry.message.kind !== 'streaming' || !entry.message.replyStreamId) return false;
    for (let i = index - 1; i >= 0; i--) {
      const prior = entries[i];
      if (!prior || prior.kind === 'activity') continue;
      if (prior.kind !== 'card') return false;
      const priorStreamId = prior.message.kind === 'streaming' || prior.message.kind === 'sulla'
        ? prior.message.replyStreamId
        : undefined;
      return !!priorStreamId && priorStreamId === entry.message.replyStreamId;
    }
    return false;
  }

  private *project(message: Message, level: ReportingLevel, needsHumanDecision?: (item: AgentResultItem) => boolean): Iterable<TranscriptEntry> {
    const base = { id: message.id, sourceId: message.id, createdAt: message.createdAt };
    if (message.kind === 'thinking') {
      if (message.chatToolActivity) {
        const activity = ChatToolReporting.describe(message.chatToolActivity);
        if (activity) yield { ...base, ...activity, kind: 'activity', level: 'debug' };
        return;
      }
      if (!Array.isArray(message.thoughts)) return;
      const type = message.reportingActivity;
      if (type === 'status' || type === 'tool') {
        const activity = message.thoughts.join('\n');
        if (!activity) return;
        yield { ...base, id: `activity:${ message.id }:0`, kind: 'activity',
          label: type === 'tool' ? 'Tool' : 'Status', level: 'debug', text: activity };
      }
      return;
    }

    if (message.kind === 'tool') {
      if (level !== 'debug' && ChatToolReporting.isBackgroundBrowse(message.recordedToolName ?? message.tool)) return;
      const text = this.toolText(message, level);
      if (text) yield { ...base, kind: 'activity', label: 'Tool',
        level: message.status === 'running' || message.tool === 'Memory' || ChatToolReporting.isMemoryTool(message.recordedToolName) ? 'debug' : 'info', text };
      return;
    }

    if (message.kind === 'sulla' && (message.terminalRunError === true ||
      (typeof message.text === 'string' && message.text.trimStart().startsWith('Agent error:')))) {
      yield { ...base, kind: 'card', label: 'Error', level: 'fatal', message };
      return;
    }
    if ((message.kind === 'sulla' || message.kind === 'streaming') && message.decisionFollowUpId &&
      message.agentReporting !== 'brief') {
      // Older replies can carry a delivered file without an explicit level.
      // Only recorded attachments qualify, never text or parsed inline links.
      const legacyDeliverable = message.agentReporting === undefined && message.kind === 'sulla' &&
        !message.fileReferencesInferred && !!message.fileReferences?.length;
      if (!legacyDeliverable) {
        yield { ...base, kind: 'card', label: 'Follow-up', level: 'info', message };
        return;
      }
    }
    if (message.kind === 'subagent' || message.kind === 'subagent_exchange') return;
    if (message.kind === 'proactive') {
      if (message.result) {
        // Preserve a path to child approvals/questions, but never keep unrelated
        // tasks from the same result batch in the Standard transcript.
        const items = message.result.items.filter(item => item.decisionIds?.length || needsHumanDecision?.(item));
        if (items.length) yield { ...base, kind: 'card', label: 'Result', level: 'fatal',
          message: { ...message, result: { ...message.result, items } } };
        return;
      }
      if (LegacyAgentNotices.parseLegacyAgentNotice(message.headline, message.body)) return;
    }
    if ((message.kind === 'sulla' || message.kind === 'streaming') &&
      message.text.includes('⟦SULLA_A2A:') && !this.agentMessages.strip(message.text).trim()) return;
    const report = Object.hasOwn(cards, message.kind) ? cards[message.kind] : undefined;
    if (!report) return;
    const label = message.kind === 'user' && message.voiceIdentity ? 'Voice' : report.label;
    const classification = message.kind === 'sulla' || message.kind === 'streaming' ||
      message.kind === 'html' || message.kind === 'proactive'
      ? message.agentReporting : undefined;
    if (classification === 'brief' || classification === 'standard') {
      yield { ...base, label, kind: 'card', message, level: classification === 'brief' ? 'fatal' : 'info' };
      return;
    }
    yield { ...base, ...report, label, kind: 'card', message,
      ...(message.kind === 'notice' && message.action ? { essential: true } : {}) };
  }

  private toolText(message: ToolMessage, level: ReportingLevel): string | undefined {
    if (level === 'debug') {
      const toolName = message.recordedToolName || message.tool || 'unknown tool';
      return `${ toolName } · ${ message.status || 'unknown' }`;
    }

    if (message.providerTool) return undefined;

    // Preserve main's Standard projection: only typed tool envelopes with a
    // known formatter label are shown, with their established friendly label.
    if (!/^\d+_tool_[\w.-]+$/.test(message.id)) return undefined;
    const isMemory = ChatToolReporting.isMemoryTool(message.recordedToolName);
    const label = isMemory ? 'Memory' : toolLabels.get(message.tool);
    const status = toolStatuses.get(message.status);
    return label && status ? `${ label } · ${ status }` : undefined;
  }
}
