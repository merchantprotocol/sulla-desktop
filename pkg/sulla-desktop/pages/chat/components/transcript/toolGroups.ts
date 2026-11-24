// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { ChatToolReporting } from '@pkg/agent/tools/ChatToolReporting';

import { returnCoveredByCard } from '../../messages/handoffCover';
import type { Message, ToolMessage } from '../../models/Message';
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
  channel:           { label: 'Agent message', level: 'info', essential: true },
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
};

// These are fixed, public progress strings emitted by the provider adapters.
// Never read ThinkingMessage.summary: older adapters derived it from the
// first line of an untyped reasoning/activity buffer.
const statuses = new Set([
  'Preparing your turn…',
  'Wrapping up the previous background task…',
  'Booting isolated environment…',
  'Tools connected — calling model',
  'Session started — calling model',
  'Steering Claude with your message…',
  'Steering Codex with your message…',
  'Claude picked up your message',
  'Asking you a question…',
]);

// Exact, payload-free messages from the provider adapters only.
const safeCliActivity = new Set([
  'Running a shell command', 'Searching files', 'Searching the web',
  'WebFetch request', 'WebSearch request', 'Spawning sub-task', 'Calling a tool',
]);

// Audited literal summaries from toolCardStrategies, keyed by formatter label.
// Match the entire recorded value; never admit a prefix, a template argument,
// a fallback derived from an arbitrary tool name, or a formatter input/output.
const safeToolSummaries: ReadonlyMap<string, readonly string[]> = new Map([
  ['Agents', ['Listing available agents', 'Listing agent directory']],
  ['Bash', ['Running command']],
  ['Bridge', ['Notifying human', 'Sending rich message', 'Updating presence', 'Checking presence']],
  ['Browser', ['Capturing page snapshot', 'Reading page text', 'Reading form values', 'Closing tab']],
  ['Calendar', ['Listing events', 'Getting event details', 'Updating event', 'Cancelling event', 'Deleting event']],
  ['Database', ['Running transaction']],
  ['Docker', ['Building image', 'Listing containers', 'Listing all containers', 'Listing images', 'Listing all images',
    'Reading container resource statistics', 'Inspecting container health', 'Reading Docker disk usage', 'Reading VM resource snapshot']],
  ['Extensions', ['Listing installed extensions', 'Browsing extension catalog']],
  ['Git', ['Checking status', 'Diffing staged changes', 'Comparing changes', 'Listing merge conflicts', 'Initializing repository']],
  ['Host', ['Running on host']],
  ['Integrations', ['Listing integrations']],
  ['Memory', ['Remembering observation']],
  ['Slack', ['Looking up user', 'Checking Slack connection']],
  ['Vault', ['Rotating vault password']],
]);

// Fixed formatter labels for structured Sulla tool cards. Do not use the
// original tool name, description, input, output, error or metadata.
const toolLabels = new Map([
  ['Agents', 'Agents'], ['Bash', 'Shell'], ['Bridge', 'Bridge'], ['Browser', 'Browser'],
  ['Calendar', 'Calendar'], ['Database', 'Database'], ['Docker', 'Docker'], ['Extensions', 'Extensions'],
  ['File', 'File'], ['Git', 'Git'], ['GitHub', 'GitHub'], ['Host', 'Host'], ['Memory', 'Memory'],
  ['Integrations', 'Integrations'], ['Redis', 'Redis'], ['Search', 'Search'], ['Skills', 'Skills'],
  ['Slack', 'Slack'], ['Vault', 'Vault'], ['Workflow', 'Workflow'], ['Workspace', 'Workspace'],
]);
const toolStatuses = new Map([['running', 'Running'], ['ok', 'Completed'], ['error', 'Failed']]);

export class TranscriptReporting {
  /** Project one active thread, never reorder or change its retained messages. */
  entries(messages: readonly Message[], level: ReportingLevel): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    const seen = new Set<string>();
    for (const message of messages) {
      if (seen.has(message.id)) continue;
      seen.add(message.id);
      for (const entry of this.project(message, messages, level)) {
        if (entry.essential || rank[entry.level] <= rank[level]) entries.push(entry);
      }
    }
    return entries;
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

  private *project(message: Message, messages: readonly Message[], level: ReportingLevel): Iterable<TranscriptEntry> {
    const base = { id: message.id, sourceId: message.id, createdAt: message.createdAt };
    if (message.kind === 'thinking') {
      if (message.chatToolActivity) {
        const activity = ChatToolReporting.describe(message.chatToolActivity);
        if (activity) yield { ...base, ...activity, kind: 'activity', level: 'debug' };
        return;
      }
      if (!Array.isArray(message.thoughts)) return;
      // Old untyped buffers can mix reasoning and activity. Only an exact,
      // standalone public status survives; never pattern-match individual lines.
      const line = message.thoughts.length === 1 ? message.thoughts[0] : undefined;
      const type = message.reportingActivity;
      const verifiedStatus = typeof line === 'string' && statuses.has(line);
      if (verifiedStatus || type === 'status' || type === 'tool') {
        const safe = verifiedStatus || (type === 'tool' && typeof line === 'string' && safeCliActivity.has(line));
        yield { ...base, id: `activity:${ message.id }:0`, kind: 'activity',
          label: type === 'tool' && !verifiedStatus ? 'Tool' : 'Status', level: 'debug',
          text: safe && line !== undefined ? line : 'Details withheld' };
      }
      return;
    }

    if (message.kind === 'tool') {
      if (ChatToolReporting.isBackgroundBrowse(message.recordedToolName ?? message.tool)) return;
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
    if (message.kind === 'subagent_exchange' && returnCoveredByCard(message, messages)) return;
    const report = Object.hasOwn(cards, message.kind) ? cards[message.kind] : undefined;
    if (!report) return;
    const label = message.kind === 'proactive' && message.result ? 'Result' :
      message.kind === 'user' && message.voiceIdentity ? 'Voice' : report.label;
    const classification = message.kind === 'sulla' || message.kind === 'streaming' ||
      message.kind === 'html' || message.kind === 'channel' || message.kind === 'proactive'
      ? message.agentReporting : undefined;
    if (classification === 'brief' || classification === 'standard') {
      yield { ...base, label, kind: 'card', message, level: classification === 'brief' ? 'fatal' : 'info' };
      return;
    }
    yield { ...base, ...report, label, kind: 'card', message,
      ...(message.kind === 'notice' && message.action ? { essential: true } : {}) };
  }

  private toolText(message: ToolMessage, level: ReportingLevel): string | undefined {
    // Match the existing MessageDispatcher envelope on live and saved paths.
    // Untyped legacy/demo cards and unsupported formatter labels fail closed.
    if (!/^\d+_tool_[\w.-]+$/.test(message.id)) return undefined;
    const isMemory = ChatToolReporting.isMemoryTool(message.recordedToolName);
    const label = isMemory ? 'Memory' : toolLabels.get(message.tool);
    const status = toolStatuses.get(message.status);
    if (level !== 'debug') return label && status ? `${ label } · ${ status }` : undefined;

    const safeSummary = label && safeToolSummaries.get(message.tool)?.includes(message.desc) ? message.desc : undefined;
    const withheld = (message.desc && !safeSummary) || message.input || message.output || message.error || message.meta;
    return [
      isMemory ? 'Memory' : label ? message.tool : 'Tool name withheld',
      status ? message.status : 'Status unavailable',
      safeSummary,
      withheld ? 'Details withheld' : undefined,
    ].filter(Boolean).join(' · ');
  }
}
