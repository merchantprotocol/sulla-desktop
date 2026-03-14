/**
 * ConversationLogger — unified conversation logging for debugging.
 *
 * Writes human-readable .log files to ~/sulla/logs/:
 *   - index.log: conversation metadata and parent-child relationships
 *   - {channel}_{threadId}.log: per-conversation event stream
 *
 * Conversation types:
 *   - "workflow": workflow execution (node events, timing, errors)
 *   - "graph": agent graph execution (messages, tool calls, LLM interactions)
 *
 * Workflows that trigger graphs produce linked conversations — the workflow
 * conversation references its child graph conversations via parentId.
 */

import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { resolveSullaLogsDir } from '../utils/sullaPaths';

// ── Types ──

export type ConversationType = 'workflow' | 'graph';

export interface ConversationMeta {
  id: string;
  type: ConversationType;
  name: string;
  parentId?: string;
  workflowId?: string;
  agentId?: string;
  channel?: string;
  startedAt: string;
  completedAt?: string;
  status?: string;
  error?: string;
}

export interface ConversationEvent {
  ts: string;
  type: string;
  [key: string]: unknown;
}

// ── Formatting helpers ──

const SEPARATOR = '════════════════════════════════════════════════════════════════';
const THIN_SEP  = '────────────────────────────────────────────────────────────────';

function formatMeta(meta: ConversationMeta | (Partial<ConversationMeta> & { id: string; _update?: boolean })): string {
  const lines: string[] = [];
  lines.push(SEPARATOR);
  const isUpdate = '_update' in meta && (meta as any)._update;
  lines.push(`[${meta.startedAt || new Date().toISOString()}] CONVERSATION ${isUpdate ? 'UPDATE' : 'START'}`);
  lines.push(SEPARATOR);
  lines.push(`ID:       ${meta.id}`);
  if (meta.type)       lines.push(`Type:     ${meta.type}`);
  if (meta.name)       lines.push(`Name:     ${meta.name}`);
  if (meta.channel)    lines.push(`Channel:  ${meta.channel}`);
  if (meta.parentId)   lines.push(`Parent:   ${meta.parentId}`);
  if (meta.workflowId) lines.push(`Workflow: ${meta.workflowId}`);
  if (meta.agentId)    lines.push(`Agent:    ${meta.agentId}`);
  if (meta.status)     lines.push(`Status:   ${meta.status}`);
  if (meta.completedAt) lines.push(`Completed: ${meta.completedAt}`);
  if (meta.error)      lines.push(`Error:    ${meta.error}`);
  lines.push('');
  return lines.join('\n');
}

function formatEvent(event: ConversationEvent): string {
  const { ts, type, ...rest } = event;

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

function formatLLMCall(ts: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  const direction = String(data.direction || 'unknown').toUpperCase();
  lines.push(SEPARATOR);
  lines.push(`[${ts}] LLM ${direction}`);
  lines.push(SEPARATOR);

  if (direction === 'REQUEST') {
    if (data.model)    lines.push(`Model:    ${data.model}`);
    if (data.provider)  lines.push(`Provider: ${data.provider}`);
    if (data.nodeName) lines.push(`Node:     ${data.nodeName}`);
    if (data.maxTokens) lines.push(`Max Tokens: ${data.maxTokens}`);
    if (data.temperature !== undefined) lines.push(`Temperature: ${data.temperature}`);
    if (data.format)   lines.push(`Format:   ${data.format}`);

    // Tools summary
    if (Array.isArray(data.tools) && data.tools.length > 0) {
      const toolNames = data.tools.map((t: any) => t?.function?.name || t?.name || 'unknown');
      lines.push(`Tools:    [${toolNames.join(', ')}]`);
    }

    // Full messages array
    if (Array.isArray(data.messages)) {
      lines.push('');
      lines.push('Messages:');
      for (const msg of data.messages as any[]) {
        lines.push(THIN_SEP);
        lines.push(`  [${msg.role}]${msg.name ? ` (${msg.name})` : ''}`);
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content, null, 2);
        lines.push(indent(content, 4));
      }
    }
  } else if (direction === 'RESPONSE') {
    if (data.model)          lines.push(`Model:         ${data.model}`);
    if (data.finishReason)   lines.push(`Finish Reason: ${data.finishReason}`);
    if (data.tokensUsed)     lines.push(`Tokens Used:   ${data.tokensUsed}`);
    if (data.promptTokens)   lines.push(`  Prompt:      ${data.promptTokens}`);
    if (data.completionTokens) lines.push(`  Completion:  ${data.completionTokens}`);
    if (data.timeSpent)      lines.push(`Time:          ${data.timeSpent}ms`);

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
      for (const tc of data.toolCalls as any[]) {
        lines.push(`  - ${tc.name}(${JSON.stringify(tc.args, null, 2)})`);
      }
    }

    if (data.error) {
      lines.push('');
      lines.push(`ERROR: ${data.error}`);
    }
  } else {
    // Unknown direction — dump everything
    for (const [k, v] of Object.entries(data)) {
      if (k === 'direction') continue;
      lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);
    }
  }

  lines.push('');
  return lines.join('\n');
}

function formatMessage(ts: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(THIN_SEP);
  lines.push(`[${ts}] MESSAGE [${data.role}]`);
  lines.push(THIN_SEP);
  lines.push(String(data.content));
  lines.push('');
  return lines.join('\n');
}

function formatToolCall(ts: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(THIN_SEP);
  lines.push(`[${ts}] TOOL CALL: ${data.toolName}`);
  lines.push(THIN_SEP);
  lines.push(`Args: ${typeof data.args === 'string' ? data.args : JSON.stringify(data.args, null, 2)}`);
  if (data.result !== undefined) {
    lines.push(`Result: ${typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)}`);
  }
  if (data.error) {
    lines.push(`Error: ${data.error}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatLifecycleEvent(ts: string, type: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  const label = type.replace(/_/g, ' ').toUpperCase();
  lines.push(SEPARATOR);
  lines.push(`[${ts}] ${label}`);
  lines.push(SEPARATOR);
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatGenericEvent(ts: string, type: string, data: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(THIN_SEP);
  lines.push(`[${ts}] ${type.toUpperCase()}`);
  lines.push(THIN_SEP);
  for (const [k, v] of Object.entries(data)) {
    lines.push(`${k}: ${typeof v === 'string' ? v : JSON.stringify(v, null, 2)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text.split('\n').map(line => pad + line).join('\n');
}

// ── Logger ──

class ConversationLoggerImpl extends EventEmitter {
  private dir: string;
  private indexPath: string;
  private indexJsonlPath: string;
  /** Maps conversationId → resolved log file path (set on start). */
  private filePaths = new Map<string, string>();
  /** Maps conversationId → resolved JSONL file path (set on start). */
  private jsonlPaths = new Map<string, string>();
  /** Set to true to disable all logging. */
  private disabled = false;

  constructor() {
    super();
    this.setMaxListeners(20);
    this.dir = resolveSullaLogsDir();
    this.indexPath = path.join(this.dir, 'index.log');
    this.indexJsonlPath = path.join(this.dir, 'index.jsonl');
  }

  private ensureDir(): void {
    if (this.disabled) return;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  /**
   * Build a log file path from channel + conversationId.
   * Produces filenames like: slack-direct_thread123.log
   * Falls back to conv_{conversationId}.log when no channel is known.
   */
  private resolveFilePath(conversationId: string, channel?: string): string {
    // Check if we already resolved a path for this conversation
    const cached = this.filePaths.get(conversationId);
    if (cached) return cached;

    const safeId = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    let filename: string;
    if (channel) {
      const safeChannel = channel.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
      filename = `${safeChannel}_${safeId}.log`;
    } else {
      filename = `conv_${safeId}.log`;
    }
    const filePath = path.join(this.dir, filename);
    this.filePaths.set(conversationId, filePath);
    return filePath;
  }

  /**
   * Build a JSONL file path for a conversation (machine-readable companion to .log).
   * Always uses conv_{id}.jsonl for predictable lookup by the monitor.
   */
  private resolveJsonlPath(conversationId: string): string {
    const cached = this.jsonlPaths.get(conversationId);
    if (cached) return cached;

    const safeId = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    const filePath = path.join(this.dir, `conv_${safeId}.jsonl`);
    this.jsonlPaths.set(conversationId, filePath);
    return filePath;
  }

  /**
   * Start a new conversation — writes an entry to the index.
   */
  start(meta: ConversationMeta): void {
    if (this.disabled) return;
    try {
      this.ensureDir();
      // Resolve and cache the file path using channel from meta
      this.resolveFilePath(meta.id, meta.channel);
      fs.appendFileSync(this.indexPath, formatMeta(meta), 'utf-8');
      // JSONL index for programmatic access (monitor dashboard)
      fs.appendFileSync(this.indexJsonlPath, JSON.stringify(meta) + '\n', 'utf-8');
      this.emit('conversation', { kind: 'start', meta });
    } catch (err) {
      console.error('[ConversationLogger] Failed to write index entry:', err);
    }
  }

  /**
   * Update a conversation's index entry (e.g. on completion).
   */
  update(meta: Partial<ConversationMeta> & { id: string }): void {
    if (this.disabled) return;
    try {
      this.ensureDir();
      fs.appendFileSync(this.indexPath, formatMeta(meta as any), 'utf-8');
      // JSONL index update for programmatic access
      fs.appendFileSync(this.indexJsonlPath, JSON.stringify({ ...meta, _update: true }) + '\n', 'utf-8');
      this.emit('conversation', { kind: 'update', meta });
    } catch (err) {
      console.error('[ConversationLogger] Failed to update index:', err);
    }
  }

  /**
   * Append an event to a conversation's event log.
   */
  log(conversationId: string, event: ConversationEvent): void {
    if (this.disabled) return;
    try {
      this.ensureDir();
      const filePath = this.resolveFilePath(conversationId);
      fs.appendFileSync(filePath, formatEvent(event), 'utf-8');
      // JSONL per-conversation events for programmatic access
      const jsonlPath = this.resolveJsonlPath(conversationId);
      fs.appendFileSync(jsonlPath, JSON.stringify(event) + '\n', 'utf-8');
      this.emit('event', { conversationId, event });
    } catch (err) {
      console.error('[ConversationLogger] Failed to write event:', err);
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
      ts:   new Date().toISOString(),
      type: 'graph_started',
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

let instance: ConversationLoggerImpl | null = null;

export function getConversationLogger(): ConversationLoggerImpl {
  if (!instance) {
    instance = new ConversationLoggerImpl();
  }
  return instance;
}
