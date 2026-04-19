/**
 * SullaLogger — unified logging for the Sulla agent subsystem.
 *
 * Combines two capabilities in a single service:
 *
 * 1. **Topic logging** (infrastructure) — console-like log/warn/error/info/debug
 *    that writes to per-topic files (e.g. websocket.log, chat.log).
 *
 *      const log = SullaLogger.topic('websocket');
 *      log.log('[WS] Connected');
 *      log.warn('[WS] Reconnecting');
 *
 * 2. **Conversation logging** — structured, per-conversation event streams
 *    (messages, LLM calls, tool calls, graph/workflow lifecycle).
 *
 *      const logger = getSullaLogger();
 *      logger.logGraphStarted(convId, 'Sulla', { channel: 'sulla-desktop' });
 *      logger.logMessage(convId, 'user', 'Hello');
 *
 * Everything lands in ~/sulla/logs/ (or $SULLA_HOME_DIR/logs/).
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';

import { autoTitleAfterMessages, type TitleMessage } from './ConversationTitleService';
import { ConversationHistoryModel } from '../database/models/ConversationHistoryModel';
import { resolveSullaLogsDir } from '../utils/sullaPaths';

// ── Types ──

export type ConversationType = 'workflow' | 'graph';

export interface ConversationMeta {
  id:           string;
  type:         ConversationType;
  name:         string;
  parentId?:    string;
  workflowId?:  string;
  agentId?:     string;
  channel?:     string;
  startedAt:    string;
  completedAt?: string;
  status?:      string;
  error?:       string;
}

export interface ConversationEvent {
  ts:            string;
  type:          string;
  [key: string]: unknown;
}

// ── Formatting helpers (conversation) ──

const SEPARATOR = '════════════════════════════════════════════════════════════════';
const THIN_SEP = '────────────────────────────────────────────────────────────────';

function formatMeta(meta: ConversationMeta | (Partial<ConversationMeta> & { id: string; _update?: boolean })): string {
  const lines: string[] = [];
  lines.push(SEPARATOR);
  const isUpdate = '_update' in meta && (meta as any)._update;
  lines.push(`[${ meta.startedAt || new Date().toISOString() }] CONVERSATION ${ isUpdate ? 'UPDATE' : 'START' }`);
  lines.push(SEPARATOR);
  lines.push(`ID:       ${ meta.id }`);
  if (meta.type) lines.push(`Type:     ${ meta.type }`);
  if (meta.name) lines.push(`Name:     ${ meta.name }`);
  if (meta.channel) lines.push(`Channel:  ${ meta.channel }`);
  if (meta.parentId) lines.push(`Parent:   ${ meta.parentId }`);
  if (meta.workflowId) lines.push(`Workflow: ${ meta.workflowId }`);
  if (meta.agentId) lines.push(`Agent:    ${ meta.agentId }`);
  if (meta.status) lines.push(`Status:   ${ meta.status }`);
  if (meta.completedAt) lines.push(`Completed: ${ meta.completedAt }`);
  if (meta.error) lines.push(`Error:    ${ meta.error }`);
  lines.push('');
  return lines.join('\n');
}

function formatEvent(event: ConversationEvent): string {
  const { ts, type, ...rest } = event;

  if (typeof type === 'string' && type.startsWith('VOICE:')) {
    return formatVoiceEvent(ts, type, rest);
  }

  switch (type) {
  case 'llm_call':
    return formatLLMCall(ts, rest);
  case 'message':
    return formatMessage(ts, rest);
  case 'tool_call':
    return formatToolCall(ts, rest);
  case 'workflow_started':
  case 'workflow_completed':
  case 'graph_started':
  case 'graph_completed':
    return formatLifecycleEvent(ts, type, rest);
  default:
    return formatGenericEvent(ts, type, rest);
  }
}

function formatVoiceEvent(ts: string, type: string, data: Record<string, unknown>): string {
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => {
      if (typeof v === 'string') {
        const clean = v.length > 200 ? v.slice(0, 200) + '…' : v;
        return `${ k }="${ clean.replace(/\n/g, '\\n') }"`;
      }
      return `${ k }=${ v }`;
    })
    .join(' ');
  return `[${ ts }] [${ type }] ${ pairs }\n`;
}

function formatLLMCall(ts: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  const direction = String(data.direction || 'unknown').toUpperCase();
  lines.push(SEPARATOR);
  lines.push(`[${ ts }] LLM ${ direction }`);
  lines.push(SEPARATOR);

  if (direction === 'REQUEST') {
    if (data.model) lines.push(`Model:    ${ data.model }`);
    if (data.provider) lines.push(`Provider: ${ data.provider }`);
    if (data.nodeName) lines.push(`Node:     ${ data.nodeName }`);
    if (data.maxTokens) lines.push(`Max Tokens: ${ data.maxTokens }`);
    if (data.temperature !== undefined) lines.push(`Temperature: ${ data.temperature }`);
    if (data.format) lines.push(`Format:   ${ data.format }`);

    if (Array.isArray(data.tools) && data.tools.length > 0) {
      const toolNames = data.tools.map((t: any) => t?.function?.name || t?.name || 'unknown');
      lines.push(`Tools:    [${ toolNames.join(', ') }]`);
    }

    if (Array.isArray(data.messages)) {
      lines.push('');
      lines.push('Messages:');
      for (const msg of data.messages) {
        lines.push(THIN_SEP);
        lines.push(`  [${ msg.role }]${ msg.name ? ` (${ msg.name })` : '' }`);
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        lines.push(indent(content, 4));
      }
    }
  } else if (direction === 'RESPONSE') {
    if (data.model) lines.push(`Model:         ${ data.model }`);
    if (data.finishReason) lines.push(`Finish Reason: ${ data.finishReason }`);
    if (data.tokensUsed) lines.push(`Tokens Used:   ${ data.tokensUsed }`);
    if (data.promptTokens) lines.push(`  Prompt:      ${ data.promptTokens }`);
    if (data.completionTokens) lines.push(`  Completion:  ${ data.completionTokens }`);
    if (data.timeSpent) lines.push(`Time:          ${ data.timeSpent }ms`);

    if (data.content !== undefined) {
      lines.push('');
      lines.push('Content:');
      lines.push(indent(String(data.content), 2));
    }

    if (data.reasoning) {
      lines.push('');
      lines.push('Reasoning:');
      lines.push(indent(String(data.reasoning), 2));
    }

    if (Array.isArray(data.toolCalls) && data.toolCalls.length > 0) {
      lines.push('');
      lines.push('Tool Calls:');
      for (const tc of data.toolCalls) {
        lines.push(`  - ${ tc.name }(${ JSON.stringify(tc.args, null, 2) })`);
      }
    }

    if (data.error) {
      lines.push('');
      lines.push(`ERROR: ${ data.error }`);
    }
  } else {
    for (const [k, v] of Object.entries(data)) {
      if (k === 'direction') continue;
      lines.push(`${ k }: ${ typeof v === 'string' ? v : JSON.stringify(v, null, 2) }`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function formatMessage(ts: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(THIN_SEP);
  lines.push(`[${ ts }] MESSAGE [${ data.role }]`);
  lines.push(THIN_SEP);
  lines.push(String(data.content));
  lines.push('');
  return lines.join('\n');
}

function formatToolCall(ts: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(THIN_SEP);
  lines.push(`[${ ts }] TOOL CALL: ${ data.toolName }`);
  lines.push(THIN_SEP);
  lines.push(`Args: ${ typeof data.args === 'string' ? data.args : JSON.stringify(data.args, null, 2) }`);
  if (data.result !== undefined) {
    lines.push(`Result: ${ typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2) }`);
  }
  if (data.error) {
    lines.push(`Error: ${ data.error }`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatLifecycleEvent(ts: string, type: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  const label = type.replace(/_/g, ' ').toUpperCase();
  lines.push(SEPARATOR);
  lines.push(`[${ ts }] ${ label }`);
  lines.push(SEPARATOR);
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${ k }: ${ typeof v === 'string' ? v : JSON.stringify(v, null, 2) }`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatGenericEvent(ts: string, type: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(THIN_SEP);
  lines.push(`[${ ts }] ${ type.toUpperCase() }`);
  lines.push(THIN_SEP);
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${ k }: ${ typeof v === 'string' ? v : JSON.stringify(v, null, 2) }`);
  }
  lines.push('');
  return lines.join('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(line => pad + line).join('\n');
}

// ══════════════════════════════════════════════════════════════════════════════
// TopicLog — console-compatible logger that writes to a single topic file
// ══════════════════════════════════════════════════════════════════════════════

type LogLevel = 'debug' | 'info';

let globalLogLevel: LogLevel = 'debug';

export function setLogLevel(level: LogLevel): void {
  globalLogLevel = level;
}

/**
 * A console-like logger backed by a file in ~/sulla/logs/{topic}.log.
 *
 * Import aliased as `console` for drop-in replacement:
 *
 *   import { wsLogger as console } from '...';
 *   console.log('works like before');
 */
export class TopicLog {
  private readonly filePath: string;
  private sessionWritten = false;

  constructor(topic: string, dir: string) {
    this.filePath = path.join(dir, `${ topic }.log`);
  }

  log(message: any, ...args: any[]): void {
    this.write('LOG', message, args);
  }

  error(message: any, ...args: any[]): void {
    this.write('ERROR', message, args);
  }

  warn(message: any, ...args: any[]): void {
    this.write('WARN', message, args);
  }

  info(message: any, ...args: any[]): void {
    this.write('INFO', message, args);
  }

  debug(message: any, ...args: any[]): void {
    if (globalLogLevel === 'debug') {
      this.write('DEBUG', message, args);
    }
  }

  private write(level: string, message: any, args: any[]): void {
    try {
      if (!this.sessionWritten) {
        this.sessionWritten = true;
        const header = `\n${ '='.repeat(80) }\n=== SESSION START: ${ new Date().toISOString() } (PID ${ process.pid }) ===\n${ '='.repeat(80) }\n`;
        fs.appendFileSync(this.filePath, header, 'utf-8');
      }

      const ts = new Date().toISOString();
      const formatted = args.length > 0
        ? util.format(message, ...args)
        : (typeof message === 'string' ? message : util.inspect(message));
      fs.appendFileSync(this.filePath, `${ ts } [${ level }] ${ formatted }\n`, 'utf-8');
    } catch {
      // Silently drop — don't let logging failures crash the app
    }
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// SullaLogger — singleton combining topic + conversation logging
// ══════════════════════════════════════════════════════════════════════════════

class SullaLogger extends EventEmitter {
  private readonly dir:            string;
  private readonly indexPath:      string;
  private readonly indexJsonlPath: string;
  /** Maps conversationId → resolved log file path (set on start). */
  private filePaths = new Map<string, string>();
  /** Maps conversationId → resolved JSONL file path (set on start). */
  private jsonlPaths = new Map<string, string>();

  // ── Activity throttle: track last DB update per conversationId ──
  private lastActivityUpdate = new Map<string, number>();
  private static readonly ACTIVITY_THROTTLE_MS = 30_000; // 30 seconds

  // ── Message accumulator for auto-title generation ──
  private messageBuffer = new Map<string, TitleMessage[]>();

  // ── Topic log cache (static, shared across all callers) ──
  private static topics = new Map<string, TopicLog>();

  constructor() {
    super();
    this.setMaxListeners(20);
    this.dir = resolveSullaLogsDir();
    this.indexPath = path.join(this.dir, 'index.log');
    this.indexJsonlPath = path.join(this.dir, 'index.jsonl');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  // ── Topic logging ────────────────────────────────────────────────────────

  /**
   * Get a console-compatible logger that writes to ~/sulla/logs/{name}.log.
   * Instances are cached — calling topic('websocket') twice returns the same object.
   */
  static topic(name: string): TopicLog {
    let t = SullaLogger.topics.get(name);
    if (!t) {
      const dir = resolveSullaLogsDir();
      fs.mkdirSync(dir, { recursive: true });
      t = new TopicLog(name, dir);
      SullaLogger.topics.set(name, t);
    }
    return t;
  }

  // ── Conversation logging ─────────────────────────────────────────────────

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private resolveFilePath(conversationId: string, channel?: string): string {
    const cached = this.filePaths.get(conversationId);
    if (cached) return cached;

    const safeId = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    let filename: string;
    if (channel) {
      const safeChannel = channel.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      filename = `${ safeChannel }_${ safeId }.log`;
    } else {
      filename = `conv_${ safeId }.log`;
    }
    const filePath = path.join(this.dir, filename);
    this.filePaths.set(conversationId, filePath);
    return filePath;
  }

  private resolveJsonlPath(conversationId: string): string {
    const cached = this.jsonlPaths.get(conversationId);
    if (cached) return cached;

    const safeId = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    const filePath = path.join(this.dir, `conv_${ safeId }.jsonl`);
    this.jsonlPaths.set(conversationId, filePath);
    return filePath;
  }

  /** Start a new conversation — writes an entry to the index. */
  start(meta: ConversationMeta): void {
    try {
      this.ensureDir();
      this.resolveFilePath(meta.id, meta.channel);
      fs.appendFileSync(this.indexPath, formatMeta(meta), 'utf-8');
      fs.appendFileSync(this.indexJsonlPath, JSON.stringify(meta) + '\n', 'utf-8');
      this.emit('conversation', { kind: 'start', meta });

      // Record to conversation history DB (fire-and-forget)
      const logFile = this.resolveJsonlPath(meta.id);
      ConversationHistoryModel.recordConversation({
        id:         meta.id,
        type:       meta.type,
        title:      meta.name,
        thread_id:  meta.id,
        channel_id: meta.channel,
        agent_id:   meta.agentId,
        status:     'active',
        log_file:   logFile,
      }).catch(err => globalThis.console.error('[SullaLogger] Failed to record conversation to history:', err));
    } catch (err) {
      // Use globalThis.console to avoid circular reference
      globalThis.console.error('[SullaLogger] Failed to write index entry:', err);
    }
  }

  /** Update a conversation's index entry (e.g. on completion). */
  update(meta: Partial<ConversationMeta> & { id: string }): void {
    try {
      this.ensureDir();
      fs.appendFileSync(this.indexPath, formatMeta(meta as any), 'utf-8');
      fs.appendFileSync(this.indexJsonlPath, JSON.stringify({ ...meta, _update: true }) + '\n', 'utf-8');
      this.emit('conversation', { kind: 'update', meta });

      // If status indicates completion, close in history DB
      if (meta.status === 'completed' || meta.status === 'failed') {
        ConversationHistoryModel.closeConversation(meta.id)
          .catch(err => globalThis.console.error('[SullaLogger] Failed to close conversation in history:', err));
      }
    } catch (err) {
      globalThis.console.error('[SullaLogger] Failed to update index:', err);
    }
  }

  /** Append an event to a conversation's event log. */
  log(conversationId: string, event: ConversationEvent): void {
    try {
      this.ensureDir();
      const filePath = this.resolveFilePath(conversationId);
      fs.appendFileSync(filePath, formatEvent(event), 'utf-8');
      const jsonlPath = this.resolveJsonlPath(conversationId);
      fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n', 'utf-8');
      this.emit('event', { conversationId, event });

      // Throttled activity update to history DB (max once per 30s per conversation)
      const now = Date.now();
      const lastUpdate = this.lastActivityUpdate.get(conversationId) ?? 0;
      if (now - lastUpdate >= SullaLogger.ACTIVITY_THROTTLE_MS) {
        this.lastActivityUpdate.set(conversationId, now);
        ConversationHistoryModel.updateActivity(conversationId)
          .catch(err => globalThis.console.error('[SullaLogger] Failed to update activity in history:', err));
      }
    } catch (err) {
      globalThis.console.error('[SullaLogger] Failed to write event:', err);
    }
  }

  // ── Convenience methods ──

  logWorkflowStarted(conversationId: string, workflowName: string, workflowId: string, opts?: { channel?: string; parentId?: string }): void {
    this.start({
      id:         conversationId,
      type:       'workflow',
      name:       workflowName,
      workflowId,
      channel:    opts?.channel,
      parentId:   opts?.parentId,
      startedAt:  new Date().toISOString(),
      status:     'running',
    });
    this.log(conversationId, {
      ts:   new Date().toISOString(),
      type: 'workflow_started',
      workflowId,
      workflowName,
    });
  }

  logWorkflowCompleted(conversationId: string, status: string, error?: string): void {
    const now = new Date().toISOString();
    this.update({ id: conversationId, completedAt: now, status, error });
    this.log(conversationId, {
      ts:   now,
      type: 'workflow_completed',
      status,
      ...(error ? { error } : {}),
    });
  }

  logNodeEvent(conversationId: string, type: string, nodeId: string, nodeLabel: string, data?: Record<string, unknown>): void {
    this.log(conversationId, {
      ts: new Date().toISOString(),
      type,
      nodeId,
      nodeLabel,
      ...data,
    });
  }

  logGraphStarted(conversationId: string, agentName: string, opts?: { agentId?: string; channel?: string; parentId?: string }): void {
    this.start({
      id:        conversationId,
      type:      'graph',
      name:      agentName,
      agentId:   opts?.agentId,
      channel:   opts?.channel,
      parentId:  opts?.parentId,
      startedAt: new Date().toISOString(),
      status:    'running',
    });
    this.log(conversationId, {
      ts:      new Date().toISOString(),
      type:    'graph_started',
      agentName,
      agentId: opts?.agentId,
    });
  }

  logGraphCompleted(conversationId: string, status: string, data?: Record<string, unknown>): void {
    const now = new Date().toISOString();
    this.update({ id: conversationId, completedAt: now, status });
    this.log(conversationId, {
      ts:   now,
      type: 'graph_completed',
      status,
      ...data,
    });
  }

  logMessage(conversationId: string, role: 'user' | 'assistant' | 'system', content: string): void {
    this.log(conversationId, {
      ts:   new Date().toISOString(),
      type: 'message',
      role,
      content,
    });

    // Accumulate messages for auto-title generation
    if (role === 'user' || role === 'assistant') {
      let buffer = this.messageBuffer.get(conversationId);

      if (!buffer) {
        buffer = [];
        this.messageBuffer.set(conversationId, buffer);
      }
      buffer.push({ role, content });

      // Trigger auto-title after threshold (fire-and-forget)
      autoTitleAfterMessages(conversationId, buffer)
        .catch(err => globalThis.console.error('[SullaLogger] Auto-title failed:', err));
    }
  }

  logToolCall(conversationId: string, toolName: string, args: unknown, result?: unknown): void {
    this.log(conversationId, {
      ts:       new Date().toISOString(),
      type:     'tool_call',
      toolName,
      args,
      ...(result !== undefined ? { result } : {}),
    });
  }

  logLLMCall(conversationId: string, direction: 'request' | 'response', data: Record<string, unknown>): void {
    this.log(conversationId, {
      ts:        new Date().toISOString(),
      type:      'llm_call',
      direction,
      ...data,
    });
  }
}

// ── Singleton ──

let instance: SullaLogger | null = null;

export function getSullaLogger(): SullaLogger {
  if (!instance) {
    instance = new SullaLogger();
  }
  return instance;
}

// ── Backward-compatible alias ──

export const getConversationLogger = getSullaLogger;

export { SullaLogger };
