// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { parseDurableFileReferences } from '@pkg/shared/filesReferences';

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
  patch:             { label: 'Change', level: 'info', essential: true },
  channel:           { label: 'Agent message', level: 'info', essential: true },
  subagent:          { label: 'Agent status', level: 'info' },
  subagent_exchange: { label: 'Handoff', level: 'info' },
  citation:          { label: 'Evidence', level: 'debug' },
  memory:            { label: 'Memory', level: 'info' },
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
const statuses = new Map([
  ['Preparing your turn…', 'Preparing your turn…'],
  ['Wrapping up the previous background task…', 'Wrapping up the previous background task…'],
  ['Booting isolated environment…', 'Booting isolated environment…'],
  ['Tools connected — calling model', 'Tools connected — calling model'],
  ['Session started — calling model', 'Session started — calling model'],
  ['Steering Claude with your message…', 'Steering with your message…'],
  ['Steering Codex with your message…', 'Steering with your message…'],
  ['Claude picked up your message', 'Your message was picked up'],
  ['Asking you a question…', 'Asking you a question…'],
]);

// Recognized CLI activity formats. Only literal, argument-free descriptions
// leave this boundary — never paths, commands, searches, URLs or tool names
// extracted from the source. Unknown text, including reasoning, is omitted.
const cliTools: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:\$ .+|Running a shell command)$/, 'Running a shell command'],
  [/^Reading .+/, 'Reading a file'],
  [/^Editing .+/, 'Editing a file'],
  [/^Writing .+/, 'Writing a file'],
  [/^(?:Searching for .+|Searching files|Grepping(?: .+)?)$/, 'Searching files'],
  [/^(?:Searching web: .+|Searching the web|Fetching .+|Web(?:Fetch|Search) request)$/, 'Searching the web'],
  [/^(?:Task: .+|Spawning sub-task)$/, 'Starting a sub-task'],
  [/^Calling a tool$/, 'Calling a tool'],
];

// Fixed formatter labels for structured Sulla tool cards. Do not use the
// original tool name, description, input, output, error or metadata.
const toolLabels = new Map([
  ['Agents', 'Agents'], ['Bash', 'Shell'], ['Bridge', 'Bridge'], ['Browser', 'Browser'],
  ['Calendar', 'Calendar'], ['Database', 'Database'], ['Docker', 'Docker'], ['Extensions', 'Extensions'],
  ['File', 'File'], ['Git', 'Git'], ['GitHub', 'GitHub'], ['Host', 'Host'],
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
      for (const entry of this.project(message, messages)) {
        if (entry.essential || rank[entry.level] <= rank[level]) entries.push(entry);
      }
    }
    return entries;
  }

  private *project(message: Message, messages: readonly Message[]): Iterable<TranscriptEntry> {
    const base = { id: message.id, sourceId: message.id, createdAt: message.createdAt };
    if (message.kind === 'thinking') {
      if (!Array.isArray(message.thoughts)) return;
      // Old untyped buffers can mix reasoning and activity. Only an exact,
      // standalone public status survives; never pattern-match individual lines.
      const line = message.thoughts.length === 1 ? message.thoughts[0] : undefined;
      const status = typeof line === 'string' ? statuses.get(line) : undefined;
      const tool = message.reportingActivity === 'tool';
      const text = status ?? (tool ? cliTools.find(([pattern]) => typeof line === 'string' && pattern.test(line))?.[1] ?? 'Calling a tool' : undefined);
      if (text) {
        yield { ...base, id: `activity:${ message.id }:0`, kind: 'activity',
          label: tool && !status ? 'Tool' : 'Status', level: 'debug', text };
      }
      return;
    }

    if (message.kind === 'tool') {
      const text = this.toolText(message);
      if (text) yield { ...base, kind: 'activity', label: 'Tool', level: message.status === 'running' ? 'debug' : 'info', text };
      return;
    }

    if (message.kind === 'sulla' && (message.terminalRunError === true ||
      (typeof message.text === 'string' && message.text.trimStart().startsWith('Agent error:')))) {
      yield { ...base, kind: 'card', label: 'Error', level: 'fatal', message };
      return;
    }
    if ((message.kind === 'sulla' || message.kind === 'streaming') && message.decisionFollowUpId &&
      !this.hasDeliverable(message)) {
      yield { ...base, kind: 'card', label: 'Follow-up', level: 'info', message };
      return;
    }
    if (message.kind === 'subagent_exchange' && returnCoveredByCard(message, messages)) return;
    const report = Object.hasOwn(cards, message.kind) ? cards[message.kind] : undefined;
    if (!report) return;
    const label = message.kind === 'proactive' && message.result ? 'Result' :
      message.kind === 'user' && message.voiceIdentity ? 'Voice' : report.label;
    yield { ...base, ...report, label, kind: 'card', message,
      ...(message.kind === 'notice' && message.action ? { essential: true } : {}) };
  }

  private hasDeliverable(message: Extract<CardMessage, { kind: 'sulla' | 'streaming' }>): boolean {
    // File references and inline document/agent cards are essential even if
    // the surrounding text was emitted during a decision continuation.
    return (message.kind === 'sulla' && !!message.fileReferences?.length) ||
      !!parseDurableFileReferences(message.text).length ||
      /⟦SULLA_A2A:|<(?:html|body|head|style|iframe|table)\b|<!doctype\b/i.test(message.text);
  }

  private toolText(message: ToolMessage): string | undefined {
    // Match the existing MessageDispatcher envelope on live and saved paths.
    // Untyped legacy/demo cards and unsupported formatter labels fail closed.
    if (!/^\d+_tool_[\w.-]+$/.test(message.id)) return undefined;
    const label = toolLabels.get(message.tool);
    const status = toolStatuses.get(message.status);
    return label && status ? `${ label } · ${ status }` : undefined;
  }
}
