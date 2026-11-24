import type { Message } from '../../models/Message';
import { TranscriptReporting, type TranscriptEntry } from './toolGroups';
import type { TraceRow, TraceRowKind, TraceRowStatus, TraceTurn } from './traceTypes';

const MAX_RENDER_CHARS = 200_000;
/** Renderer projection: it deliberately preserves the complete recorded trace. */
export class DetailedTraceProjection {
  constructor(private readonly reporting = new TranscriptReporting()) {}
  project(messages: readonly Message[], standardEntries: readonly TranscriptEntry[]): TraceTurn[] {
    const debug = this.reporting.entries(messages, 'debug');
    const standardIds = new Set(standardEntries.map(entry => entry.sourceId));
    const activities = new Map<string, string[]>();
    for (const entry of debug) {
      if (entry.kind !== 'activity' || standardIds.has(entry.sourceId)) continue;
      const values = activities.get(entry.sourceId) ?? [];
      values.push(entry.text);
      activities.set(entry.sourceId, values);
    }
    return this.groups(messages).map((group, i) => {
      const reply = group.find(m => m.kind === 'sulla' || m.kind === 'streaming');
      const anchor = this.anchorFor(reply ?? group.at(-1)!, standardEntries);
      const rows = group.flatMap(message => this.rowsFor(message, anchor, activities.get(message.id)));
      const replies = group.filter(m => m.kind === 'sulla') as Extract<Message, {kind:'sulla'}>[];
      const tokens = replies.reduce((sum, m) => sum + (m.tokens ?? 0), 0);
      const model = replies.find(m => m.replyAttribution?.model)?.replyAttribution?.model ?? replies.find(m => m.model)?.model;
      return { id: `trace:${group[0]?.turnId ?? group[0]?.id ?? i}`, anchorEntryId: anchor, rows, ...(model || tokens ? { usage: { ...(model ? {model} : {}), ...(tokens ? {totalTokens: tokens} : {}) } } : {}) };
    }).filter(turn => turn.rows.length > 0 || !!turn.usage);
  }
  private groups(messages: readonly Message[]): Message[][] { const out: Message[][] = []; let current: Message[] = []; for (const m of messages) { if (m.kind === 'user' && current.length) { out.push(current); current = []; } current.push(m); } if (current.length) out.push(current); return out; }
  private anchorFor(message: Message, entries: readonly TranscriptEntry[]): string { return entries.find(e => e.sourceId === message.id)?.id ?? entries.at(-1)?.id ?? '__trace-trailing__'; }
  private rowsFor(message: Message, anchor: string, activities?: readonly string[]): TraceRow[] {
    const rows = (activities ?? []).map((text, i) => this.row(`${message.id}:activity:${i}`, 'activity', 'Status', text, 'ok', anchor, message.createdAt));
    const m = message as Message & Record<string, any>;
    if (message.kind === 'thinking') return rows.concat((m.thoughts ?? []).map((text: string, i: number) => this.row(`${message.id}:thought:${i}`, 'thought', '', text, 'ok', anchor, message.createdAt, undefined, undefined, this.serialize({ thoughts: m.thoughts, summary: m.summary }))));
    if (message.kind === 'tool') {
      const tool = m.recordedToolName ?? m.tool;
      const status: TraceRowStatus = m.status === 'error' ? 'failed' : m.status === 'running' ? 'running' : 'ok';
      return rows.concat(this.row(message.id, 'tool', status === 'running' ? 'Calling' : 'Used', tool, status, anchor, message.createdAt, this.duration(m.startedAt, m.completedAt, m.meta), this.summary(m.input), this.serialize({ tool: tool, input: m.input, output: m.output, error: m.error })));
    }
    if (message.kind === 'memory' || message.kind === 'heartbeat') return rows.concat(this.row(message.id, message.kind, message.kind === 'memory' ? String(m.action ?? 'Memory') : 'Heartbeat', this.summary(m.memId ?? m.intervalMinutes ?? m.id), 'ok', anchor, message.createdAt, undefined, undefined, this.serialize(m)));
    if (message.kind === 'subagent_exchange') return rows.concat(this.row(message.id, m.direction === 'to_agent' ? 'handoff' : 'activity', String(m.direction), this.summary(m.label), 'ok', anchor, message.createdAt, undefined, this.summary(m.summary), this.serialize(m)));
    if (message.kind === 'tool_approval') return rows.concat(this.row(message.id, 'approval', 'Approval', this.summary(m.command), m.decision === 'pending' ? 'waiting' : m.decision === 'approved' ? 'approved' : 'failed', anchor, message.createdAt, undefined, undefined, this.serialize(m)));
    if (message.kind === 'citation') return rows.concat((m.sources ?? []).map((source: unknown, i: number) => this.row(`${message.id}:${i}`, 'source', 'Source', this.summary((source as any).title), 'ok', anchor, message.createdAt, undefined, this.summary((source as any).origin), this.serialize(source))));
    return rows;
  }
  private row(id: string, kind: TraceRowKind, verb: string, target: string, status: TraceRowStatus, anchorEntryId: string, at: number, durationLabel?: string, keyArgs?: string, rawPayload?: string): TraceRow { const value = String(target); return { id, kind, verb, target: value, targetIsCode: /(?:[/$\\]|\.(?:ts|js|json|sh)\b|\s--?[a-z])/i.test(value), status, ...(keyArgs ? {keyArgs} : {}), ...(durationLabel ? {durationLabel} : {}), ...(rawPayload ? {rawPayload} : {}), anchorEntryId, at }; }
  private summary(value: unknown): string { if (value == null) return ''; if (typeof value === 'string') return value.replace(/\s+/g, ' ').trim(); return this.serialize(value).replace(/\s+/g, ' ').trim(); }
  private serialize(value: unknown): string { let text: string; try { text = typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value); } catch { text = String(value); } return text.length > MAX_RENDER_CHARS ? `${text.slice(0, MAX_RENDER_CHARS)}… truncated` : text; }
  private duration(start?: number, end?: number, meta?: string): string | undefined { if (typeof start === 'number' && typeof end === 'number') return `${Math.max(0, end - start)}ms`; return meta?.match(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/i)?.[0]; }
}
