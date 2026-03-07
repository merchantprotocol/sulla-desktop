/**
 * ConversationLogger — unified conversation logging for debugging and training.
 *
 * Writes structured JSONL logs to ~/sulla/conversations/:
 *   - index.jsonl: conversation metadata and parent-child relationships
 *   - conv-{id}.jsonl: per-conversation event stream
 *
 * Conversation types:
 *   - "workflow": workflow execution (node events, timing, errors)
 *   - "graph": agent graph execution (messages, tool calls, LLM interactions)
 *
 * Workflows that trigger graphs produce linked conversations — the workflow
 * conversation references its child graph conversations via parentId.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveSullaConversationsDir } from '../utils/sullaPaths';

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

// ── Logger ──

class ConversationLoggerImpl {
  private dir: string;
  private indexPath: string;

  constructor() {
    this.dir = resolveSullaConversationsDir();
    this.indexPath = path.join(this.dir, 'index.jsonl');
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private eventFilePath(conversationId: string): string {
    const safe = conversationId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    return path.join(this.dir, `conv-${safe}.jsonl`);
  }

  /**
   * Start a new conversation — writes an entry to the index.
   */
  start(meta: ConversationMeta): void {
    try {
      this.ensureDir();
      fs.appendFileSync(this.indexPath, JSON.stringify(meta) + '\n', 'utf-8');
    } catch (err) {
      console.error('[ConversationLogger] Failed to write index entry:', err);
    }
  }

  /**
   * Update a conversation's index entry (e.g. on completion).
   * Appends a new line with the same id — readers use the last entry per id.
   */
  update(meta: Partial<ConversationMeta> & { id: string }): void {
    try {
      this.ensureDir();
      fs.appendFileSync(this.indexPath, JSON.stringify({ ...meta, _update: true }) + '\n', 'utf-8');
    } catch (err) {
      console.error('[ConversationLogger] Failed to update index:', err);
    }
  }

  /**
   * Append an event to a conversation's event log.
   */
  log(conversationId: string, event: ConversationEvent): void {
    try {
      this.ensureDir();
      const filePath = this.eventFilePath(conversationId);
      fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8');
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
      content: content.length > 10000 ? content.slice(0, 10000) + '...' : content,
    });
  }

  logToolCall(conversationId: string, toolName: string, args: unknown, result?: unknown): void {
    this.log(conversationId, {
      ts:       new Date().toISOString(),
      type:     'tool_call',
      toolName,
      args:     truncate(args),
      ...(result !== undefined ? { result: truncate(result) } : {}),
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

function truncate(value: unknown, maxLen = 2000): unknown {
  if (typeof value === 'string' && value.length > maxLen) {
    return value.slice(0, maxLen) + '...';
  }
  if (typeof value === 'object' && value !== null) {
    const str = JSON.stringify(value);
    if (str.length > maxLen) {
      return JSON.parse(str.slice(0, maxLen - 20) + '..."truncated":true}');
    }
  }
  return value;
}

// ── Singleton ──

let instance: ConversationLoggerImpl | null = null;

export function getConversationLogger(): ConversationLoggerImpl {
  if (!instance) {
    instance = new ConversationLoggerImpl();
  }
  return instance;
}
