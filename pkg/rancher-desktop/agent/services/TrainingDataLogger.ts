/**
 * TrainingDataLogger — append-only training data capture for fine-tuning.
 *
 * Captures clean, OpenAI-compatible message objects to ~/sulla/training/[sessionId].jsonl.
 * One message per line, one appendFileSync per message. Fire-and-forget — never blocks.
 *
 * Post-processing wraps all lines into {"messages": [...]} for OpenAI JSONL format.
 *
 * Strips all internal metadata (nodeId, __toolRuns, etc.), normalizes tool calls
 * from Anthropic native to OpenAI format, preserves reasoning traces, and embeds
 * sub-agent conversations inline.
 */

import fs from 'node:fs';
import path from 'node:path';

import { resolveSullaConversationsDir } from '../utils/sullaPaths';

// ── Types ──

export interface TrainingMessage {
  role:        'system' | 'user' | 'assistant' | 'tool';
  content?:    string | null;
  tool_calls?: {
    id:       string;
    type:     'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
  reasoning?:    string;
}

interface TrainingSession {
  sessionId:          string;
  filePath:           string;
  allMessages:        TrainingMessage[];
  systemPromptLogged: boolean;
  lastUserContent?:   string;
}

// ── Logger ──

class TrainingDataLoggerImpl {
  private dir: string;
  private activeSessions = new Map<string, TrainingSession>();

  constructor() {
    this.dir = resolveSullaConversationsDir();
  }

  private ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  private sessionFilePath(sessionId: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
    return path.join(this.dir, `${ safe }.jsonl`);
  }

  private append(session: TrainingSession, msg: TrainingMessage): void {
    session.allMessages.push(msg);
    try {
      fs.appendFileSync(session.filePath, JSON.stringify(msg) + '\n', 'utf-8');
    } catch (err) {
      console.error('[TrainingDataLogger] Write failed:', err);
    }
  }

  // ── Session lifecycle ──

  startSession(sessionId: string, _meta?: { agentId?: string; model?: string }): void {
    if (this.activeSessions.has(sessionId)) return;
    try {
      this.ensureDir();
      const session: TrainingSession = {
        sessionId,
        filePath:           this.sessionFilePath(sessionId),
        allMessages:        [],
        systemPromptLogged: false,
      };
      this.activeSessions.set(sessionId, session);
    } catch (err) {
      console.error('[TrainingDataLogger] Failed to start session:', err);
    }
  }

  endSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);
  }

  // ── Message logging ──

  logSystemPrompt(sessionId: string, content: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.systemPromptLogged) return;
    session.systemPromptLogged = true;
    this.append(session, { role: 'system', content });
  }

  logUserMessage(sessionId: string, content: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    // Dedup: skip if same content as last logged user message
    if (session.lastUserContent === content) return;
    session.lastUserContent = content;
    this.append(session, { role: 'user', content });
  }

  logAssistantMessage(sessionId: string, content: string, opts?: { reasoning?: string }): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const msg: TrainingMessage = { role: 'assistant', content };
    if (opts?.reasoning) msg.reasoning = opts.reasoning;
    this.append(session, msg);
  }

  logToolCall(
    sessionId: string,
    calls: { id: string; name: string; args: any }[],
    textContent?: string | null,
    opts?: { reasoning?: string },
  ): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    const msg: TrainingMessage = {
      role:       'assistant',
      content:    textContent || null,
      tool_calls: calls.map(tc => ({
        id:       tc.id,
        type:     'function' as const,
        function: {
          name:      tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
        },
      })),
    };
    if (opts?.reasoning) msg.reasoning = opts.reasoning;
    this.append(session, msg);
  }

  logToolResult(sessionId: string, toolCallId: string, content: string): void {
    const session = this.activeSessions.get(sessionId);
    if (!session) return;
    this.append(session, {
      role:         'tool',
      tool_call_id: toolCallId,
      content,
    });
  }

  // ── Sub-agent embedding ──

  embedSubAgentConversation(parentSessionId: string, subSessionId: string, nodeLabel: string): void {
    const parent = this.activeSessions.get(parentSessionId);
    const sub = this.activeSessions.get(subSessionId);
    if (!parent || !sub) return;

    const serialized = this.serializeSubAgent(sub.allMessages, nodeLabel);
    this.append(parent, { role: 'assistant', content: serialized });

    // Clean up sub-session: remove from memory and delete its file
    this.activeSessions.delete(subSessionId);
    try {
      if (fs.existsSync(sub.filePath)) {
        fs.unlinkSync(sub.filePath);
      }
    } catch { /* best-effort cleanup */ }
  }

  private serializeSubAgent(messages: TrainingMessage[], label: string): string {
    const lines: string[] = [`[Sub-Agent: ${ label }]`];

    for (const msg of messages) {
      switch (msg.role) {
      case 'system':
        lines.push('--- System ---');
        lines.push(msg.content ? msg.content.slice(0, 500) : '');
        break;
      case 'user':
        lines.push('--- User ---');
        lines.push(msg.content || '');
        break;
      case 'assistant':
        if (msg.tool_calls?.length) {
          const reasoningNote = msg.reasoning ? ` (reasoning: "${ msg.reasoning.slice(0, 200) }")` : '';
          lines.push(`--- Assistant${ reasoningNote } ---`);
          if (msg.content) lines.push(msg.content);
          for (const tc of msg.tool_calls) {
            lines.push(`--- Tool Call: ${ tc.function.name }(${ tc.function.arguments }) ---`);
          }
        } else {
          const reasoningNote = msg.reasoning ? ` (reasoning: "${ msg.reasoning.slice(0, 200) }")` : '';
          lines.push(`--- Assistant${ reasoningNote } ---`);
          lines.push(msg.content || '');
        }
        break;
      case 'tool':
        lines.push('--- Tool Result ---');
        lines.push(msg.content || '');
        break;
      }
    }

    lines.push('--- End Sub-Agent ---');
    return lines.join('\n');
  }

  // ── Introspection ──

  hasSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  getSessionMessages(sessionId: string): TrainingMessage[] | null {
    return this.activeSessions.get(sessionId)?.allMessages ?? null;
  }
}

// ── Singleton ──

let instance: TrainingDataLoggerImpl | null = null;

export function getTrainingDataLogger(): TrainingDataLoggerImpl {
  if (!instance) {
    instance = new TrainingDataLoggerImpl();
  }
  return instance;
}
