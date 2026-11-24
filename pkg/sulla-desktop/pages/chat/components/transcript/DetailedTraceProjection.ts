// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { TracePayloadRedactor } from '@pkg/agent/tools/TracePayloadRedactor';
import type { DetailedTraceUsageSample } from '@pkg/agent/database/models/DetailedTraceUsage';
import { ChatToolReporting } from '@pkg/agent/tools/ChatToolReporting';

import type {
  Message, ToolMessage,
} from '../../models/Message';
import type { TranscriptEntry } from './toolGroups';

export type TraceStatus = 'ok' | 'running' | 'failed' | 'waiting' | 'approved' | 'denied' | 'stopped' | 'cancelled';
export type TraceRowKind = 'thought' | 'tool' | 'file' | 'read' | 'search' | 'memory' | 'handoff' | 'result' | 'approval' | 'question' | 'agent' | 'error' | 'notice' | 'heartbeat';

export interface DetailedTraceRow {
  id: string;
  sourceId: string;
  kind: TraceRowKind;
  verb: string;
  target: string;
  toolName?: string;
  args?: string;
  durationMs?: number;
  status?: TraceStatus;
  note?: string;
  rawPayload?: unknown;
}

export interface DetailedTraceMetadata {
  agent?: string;
  startedAt?: number;
  model?: string;
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  steps?: number;
  files?: number;
  failures?: number;
}

export interface DetailedTraceTurn {
  id: string;
  afterId?: string;
  rows: DetailedTraceRow[];
  metadata: DetailedTraceMetadata;
}

interface MutableTurn {
  id: string;
  afterId?: string;
  rows: DetailedTraceRow[];
  messages: Message[];
  metrics: DetailedTraceUsageSample[];
}

const targetKeys = ['command', 'cmd', 'url', 'path', 'file', 'query', 'name', 'slug'] as const;
const publicStatuses = new Set([
  'Preparing your turn…', 'Wrapping up the previous background task…', 'Booting isolated environment…',
  'Tools connected — calling model', 'Session started — calling model', 'Steering Claude with your message…',
  'Steering Codex with your message…', 'Claude picked up your message', 'Asking you a question…',
]);
const safeActivities = new Set([
  'Running a shell command', 'Searching files', 'Searching the web', 'WebFetch request', 'WebSearch request',
  'Spawning sub-task', 'Calling a tool',
]);

/** Converts detailed-only events into one stable rail and one row grammar. */
export class DetailedTraceProjection {
  private readonly payloadRedactor = new TracePayloadRedactor();
  private readonly payloadCache = new WeakMap<Message, Map<string, unknown>>();

  project(
    messages: readonly Message[],
    entries: readonly TranscriptEntry[],
    usage: readonly DetailedTraceUsageSample[] = [],
    standardEntries: readonly TranscriptEntry[] = entries.filter(entry => entry.level !== 'debug'),
    tracePayloads: ReadonlyMap<string, unknown> = new Map(),
    threadId?: string,
  ): DetailedTraceTurn[] {
    const activity = new Map(entries.flatMap(entry => entry.kind === 'activity' ? [[entry.sourceId, entry.text] as const] : []));
    const visible = new Map(standardEntries.map(entry => [entry.sourceId, entry.id]));
    const turnByMessage = new Map<string, MutableTurn>();
    const turns: MutableTurn[] = [];
    let turn: MutableTurn | undefined;
    let lastVisible: string | undefined;
    for (const message of messages) {
      if (turnByMessage.has(message.id)) continue;
      if (message.kind === 'user') {
        turn = { id: `trace:${ message.id }`, afterId: visible.get(message.id) ?? lastVisible, rows: [], messages: [message], metrics: [] };
        turns.push(turn);
        turnByMessage.set(message.id, turn);
        lastVisible = visible.get(message.id) ?? lastVisible;
        continue;
      }
      if (!turn) {
        turn = { id: `trace:${ message.id }`, afterId: lastVisible ?? visible.get(message.id), rows: [], messages: [], metrics: [] };
        turns.push(turn);
      }
      turnByMessage.set(message.id, turn);
      turn.messages.push(message);
      turn.rows.push(...this.rowsFor(message, activity.get(message.id), tracePayloads));
      lastVisible = visible.get(message.id) ?? lastVisible;
    }
    for (const sample of usage) {
      if (!sample.afterId || !sample.threadId || !sample.runId || !sample.nodeId || (threadId && sample.threadId !== threadId)) continue;
      // Usage is attached only to the exact originating user anchor. A timestamp
      // fallback can silently charge one turn's metrics to its neighbor.
      turnByMessage.get(sample.afterId)?.metrics.push(sample);
    }
    return turns.filter(candidate => candidate.rows.length || candidate.metrics.length ||
      candidate.messages.some(message => message.kind === 'sulla' || message.kind === 'streaming'))
      .map(candidate => this.finish(candidate));
  }

  private rowsFor(message: Message, safeActivity?: string, tracePayloads: ReadonlyMap<string, unknown> = new Map()): DetailedTraceRow[] {
    switch (message.kind) {
      case 'thinking': {
        const text = safeActivity ?? this.safeThinkingStatus(message);
        return text ? [this.row(message, 'thought', 'Considering', text)] : [];
      }
      case 'tool': return ChatToolReporting.isBackgroundBrowse(message.recordedToolName ?? message.tool) ? [] :
        [this.toolRow(message, tracePayloads.get(message.id))];
      case 'patch': {
        const diff = message.hunks.flatMap(hunk => hunk.lines.map(line => `${ line.op === 'add' ? '+' : line.op === 'remove' ? '-' : ' ' }${ line.text }`)).join('\n');
        return [this.row(message, 'file', 'Edited', message.path, `${ message.stat.added } added · ${ message.stat.removed } removed`, message.state === 'applied' ? 'ok' : 'waiting', {
          file: message.path, state: message.state, diff,
        })];
      }
      case 'citation': return message.sources.map((source, index) => ({
        ...this.row(message, 'read', 'Read source', source.title, source.origin, 'ok', source, `source:${ source.num ?? index }`),
        id: `${ message.id }:source:${ source.num ?? index }`,
      }));
      case 'memory': return [this.row(message, 'memory', ({ saved: 'Saved', updated: 'Updated', removed: 'Removed' })[message.action], message.memId,
        undefined, 'ok', message)];
      case 'heartbeat': return [this.row(message, 'heartbeat', 'Heartbeat', `${ message.intervalMinutes } minute interval`, undefined, 'ok', message)];
      case 'tool_approval': return [this.row(message, 'approval', 'Approval', message.command, undefined,
        ({ pending: 'waiting', approved: 'approved', denied: 'denied', timed_out: 'cancelled' })[message.decision], message)];
      case 'tool_question': return [this.row(message, 'question', 'Asked', message.questions[0]?.question ?? 'User input',
        message.questions.length > 1 ? `${ message.questions.length } questions` : undefined,
        ({ pending: 'waiting', answered: 'ok', timed_out: 'cancelled' })[message.status], message)];
      case 'subagent_exchange': return [this.row(message, message.direction === 'to_agent' ? 'handoff' : 'result', message.direction === 'to_agent' ? 'Handed off to' : 'Result from',
        message.label || message.agentId, message.jobId ? `job ${ message.jobId }` : undefined,
        ({ running: 'running', done: 'ok', failed: 'failed', stopped: 'stopped' })[message.status], message)];
      case 'subagent': return [this.row(message, 'result', message.status === 'running' ? 'Working with' : 'Result from', message.name,
        undefined, ({ running: 'running', done: 'ok', error: 'failed' })[message.status], message)];
      case 'channel': return [this.row(message, 'agent', 'Message from', message.agent, message.channel, 'ok', message)];
      case 'proactive': return [this.row(message, 'result', message.result ? 'Background result' : 'Update', message.headline,
        undefined, message.result?.status === 'failed' ? 'failed' : 'ok', message)];
      case 'error': return [this.row(message, 'error', 'Failed', 'Agent step', undefined, 'failed', message)];
      case 'notice': return [this.row(message, 'notice', 'Noted', message.text, undefined, undefined, message)];
      case 'sulla': return message.terminalRunError ? [this.row(message, 'error', 'Failed', 'Agent response', undefined, 'failed', message)] : [];
      default: return [];
    }
  }

  private toolRow(message: ToolMessage, tracePayload?: unknown): DetailedTraceRow {
    const details = tracePayload && typeof tracePayload === 'object' && !Array.isArray(tracePayload)
      ? tracePayload as { args?: Readonly<Record<string, unknown>>; result?: unknown }
      : undefined;
    const args = details?.args;
    const targetValue = args ? this.targetValue(args) : undefined;
    const target = this.safeText(targetValue || message.desc || message.tool);
    const toolName = (message.recordedToolName ?? message.tool).toLowerCase();
    const status: TraceStatus = message.status === 'error'
      ? /cancel(?:led|ed)?/i.test(message.error ?? '') ? 'cancelled' : 'failed'
      : message.status === 'ok' ? 'ok' : 'running';
    const shownArgs = args ? this.argumentSummary(args) : this.safeText(message.input ?? '');
    const note = (status === 'failed' || status === 'cancelled') ? this.safeText(message.error ?? 'Tool call failed') :
      message.output ? this.safeText(message.output) : undefined;
    const kind: TraceRowKind = toolName.startsWith('memory_') || message.tool.toLowerCase() === 'memory' ? 'memory' :
      /(?:^|[_-])search(?:$|[_-])/.test(toolName) ? 'search' :
        /(?:^|[_-])(?:read|fetch)(?:$|[_-])/.test(toolName) ? 'read' :
          /(?:^|[_-])(?:create|write|edit|update|delete|move|copy|patch)(?:$|[_-])/.test(toolName) || message.tool.toLowerCase() === 'file' ? 'file' : 'tool';
    const verb = this.toolVerb(toolName, message.tool, status);
    return {
      id: message.id,
      sourceId: message.id,
      kind,
      verb,
      target,
      toolName: this.safeText(message.recordedToolName ?? message.tool),
      ...(shownArgs ? { args: shownArgs } : {}),
      ...(typeof message.durationMs === 'number' && Number.isFinite(message.durationMs) ? { durationMs: Math.max(0, message.durationMs) } : {}),
      status,
      ...(note ? { note } : {}),
      rawPayload: this.cachedPayload(message, 'tool', {
        tool: message.recordedToolName ?? message.tool,
        args: args ?? message.input,
        result: details?.result,
        output: message.output,
        error: message.error,
      }),
    };
  }

  private toolVerb(toolName: string, label: string, status: TraceStatus): string {
    if (status === 'running') return 'Calling';
    if (/^(?:exec|exec_command|shell|bash|run_command)$/.test(toolName)) return 'Ran';
    if (toolName.includes('search')) return 'Searched';
    if (toolName.includes('read') || toolName.includes('fetch')) return 'Read';
    if (toolName.includes('create') || toolName.includes('write')) return 'Created';
    if (toolName.includes('edit') || toolName.includes('update')) return 'Edited';
    return label.toLowerCase() === 'browser' ? 'Opened' : 'Used';
  }

  private row(
    message: Message,
    kind: TraceRowKind,
    verb: string,
    target: string,
    args?: string,
    status?: TraceStatus,
    payload?: unknown,
    payloadKey = kind,
  ): DetailedTraceRow {
    const messageNote = message.kind === 'subagent_exchange' ? message.summary :
      message.kind === 'subagent' ? message.desc :
        message.kind === 'memory' ? message.summary :
          message.kind === 'heartbeat' ? message.text :
            message.kind === 'channel' ? message.text :
              message.kind === 'proactive' ? message.body :
                message.kind === 'error' ? [message.text, message.detail].filter(Boolean).join(' · ') :
                  message.kind === 'notice' ? message.detail :
                    message.kind === 'tool_approval' ? message.reason :
                      message.kind === 'tool_question' ? message.questions.map(question => question.question).join(' · ') : undefined;
    const rawPayload = payload === undefined ? undefined : this.cachedPayload(message, payloadKey, payload);
    return {
      id: message.id,
      sourceId: message.id,
      kind,
      verb: this.safeText(verb),
      target: this.safeText(target),
      ...(args ? { args: this.safeText(args) } : {}),
      ...(status ? { status } : {}),
      ...(messageNote ? { note: this.safeText(messageNote) } : {}),
      ...(rawPayload ? { rawPayload } : {}),
    };
  }

  private cachedPayload(message: Message, key: string, payload: unknown): unknown {
    let byKey = this.payloadCache.get(message);
    if (!byKey) {
      byKey = new Map();
      this.payloadCache.set(message, byKey);
    }
    if (byKey.has(key)) return byKey.get(key);
    byKey.set(key, payload);
    return payload;
  }

  private finish(turn: MutableTurn): DetailedTraceTurn {
    const orderedRows = [...turn.rows];
    let next: DetailedTraceRow | undefined;
    for (let index = orderedRows.length - 1; index >= 0; index--) {
      const row = orderedRows[index];
      if (row.kind === 'thought') continue;
      if (row.status === 'failed' && next) {
        if (row.toolName && row.toolName === next.toolName && row.target === next.target) next.verb = 'Retried';
        row.note = `${ row.note ? `${ row.note } · ` : '' }Next: ${ next.verb } ${ next.target }.`;
      }
      next = row;
    }

    const metrics = turn.metrics;
    const metricModels = [...new Set(metrics.map(metric => metric.model).filter((model): model is string => !!model?.trim()))];
    const replies = turn.messages.filter((message): message is Extract<Message, { kind: 'sulla' }> => message.kind === 'sulla');
    const agent = replies.find(reply => reply.replyAttribution?.agent)?.replyAttribution?.agent ??
      turn.messages.find(message => message.by?.agent)?.by?.agent ?? (replies.length ? 'Sulla' : undefined);
    const replyModel = replies.find(reply => reply.replyAttribution?.model)?.replyAttribution?.model;
    const first = turn.messages.find(message => message.createdAt > 0 && Number.isFinite(message.createdAt));
    const startedAt = first?.createdAt;
    const durations = metrics.map(metric => metric.durationMs).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const toolDurations = orderedRows.map(row => row.durationMs).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    const inputTokens = metrics.reduce((sum, metric) => sum + (metric.inputTokens ?? 0), 0);
    const outputTokens = metrics.reduce((sum, metric) => sum + (metric.outputTokens ?? 0), 0);
    const metadata: DetailedTraceMetadata = {
      ...(agent ? { agent: this.safeText(agent) } : {}),
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...((replyModel ?? metricModels.join(' · ')) ? { model: this.safeText(replyModel ?? metricModels.join(' · ')) } : {}),
      ...(durations.length ? { durationMs: durations.reduce((sum, duration) => sum + Math.max(0, duration), 0) } :
        toolDurations.length ? { durationMs: toolDurations.reduce((sum, duration) => sum + Math.max(0, duration), 0) } : {}),
      ...(metrics.some(metric => metric.inputTokens !== undefined) ? { inputTokens } : {}),
      ...(metrics.some(metric => metric.outputTokens !== undefined) ? { outputTokens } : {}),
      ...(turn.messages.length ? { steps: orderedRows.filter(row => row.kind !== 'thought').length } : {}),
      ...(orderedRows.some(row => row.kind === 'file') ? { files: orderedRows.filter(row => row.kind === 'file').length } : {}),
      ...(orderedRows.some(row => row.status === 'failed') ? { failures: orderedRows.filter(row => row.status === 'failed').length } : {}),
    };
    return { id: turn.id, afterId: turn.afterId, rows: orderedRows, metadata };
  }

  private safeThinkingStatus(message: Extract<Message, { kind: 'thinking' }>): string | undefined {
    if (message.thoughts.length !== 1) return undefined;
    const line = message.thoughts[0];
    return publicStatuses.has(line) || (message.reportingActivity === 'tool' && safeActivities.has(line)) ? line : undefined;
  }

  private targetValue(args: Readonly<Record<string, unknown>>): string | undefined {
    for (const key of targetKeys) {
      const value = args[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return undefined;
  }

  private argumentSummary(args: Readonly<Record<string, unknown>>): string {
    const targetKey = targetKeys.find(key => typeof args[key] === 'string' && String(args[key]).trim());
    const entries = Object.entries(args).filter(([key]) => key !== targetKey).slice(0, 3);
    return entries.map(([key, value]) => `${ key }=${ this.valueLabel(value) }`).join(' · ');
  }

  private valueLabel(value: unknown): string {
    if (typeof value === 'string') return this.safeText(value, 64);
    if (Array.isArray(value)) return `${ value.length } items`;
    if (value && typeof value === 'object') return '{…}';
    return String(value ?? 'null');
  }

  private safeText(value: string, maxChars = 240): string {
    const safe = this.payloadRedactor.redactText(value.trim());
    return safe.length <= maxChars ? safe : `${ safe.slice(0, maxChars) }…`;
  }
}
