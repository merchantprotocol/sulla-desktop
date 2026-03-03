import fs from 'fs';
import os from 'os';
import path from 'path';
import { app } from 'electron';

type LLMLogEvent = {
  direction: 'request' | 'response' | 'error';
  provider: string;
  model?: string;
  endpoint?: string;
  nodeName?: string;
  conversationId?: string;
  payload: unknown;
  attempt?: number;
};

const PROJECT_LOG_DIR = path.join(process.cwd(), 'log');
const LOG_FILE_PREFIX = 'llm-conversation';

// ---------------------------------------------------------------------------
// Training data writer — writes completed conversations to feedback_queue/
// ---------------------------------------------------------------------------

/** Cache the last request messages per conversation so we can pair them with responses. */
const pendingRequests = new Map<string, Record<string, unknown>[]>();

/** Resolve the feedback_queue directory under app.getPath('userData')/llm/ */
function getFeedbackQueueDir(): string {
  let userDataPath: string;
  try {
    userDataPath = app.getPath('userData');
  } catch {
    // Fallback if app not ready yet (shouldn't happen at log-write time)
    userDataPath = path.join(os.homedir(), 'Library', 'Application Support', 'rancher-desktop');
  }
  return path.join(userDataPath, 'llm', 'feedback_queue');
}

/**
 * Extract clean text content from a message content field.
 * Handles strings, arrays (Anthropic-style content blocks), and objects.
 */
function extractTextContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block: any) => {
        if (typeof block === 'string') return block;
        if (block?.type === 'text' && typeof block.text === 'string') return block.text;
        if (block?.type === 'tool_use' || block?.type === 'tool_result') return ''; // skip tool blocks
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/**
 * Write a completed conversation exchange to the feedback_queue as JSONL.
 * Only writes exchanges where the assistant produced real text content
 * (not just tool calls).
 */
function writeTrainingEntry(
  requestMessages: Record<string, unknown>[],
  assistantContent: string,
): void {
  if (!assistantContent || assistantContent.length < 10) return;

  // Build a clean messages array: keep system + the last user message + the new assistant reply
  const cleanMessages: { role: string; content: string }[] = [];

  // Include the system message if present
  const systemMsg = requestMessages.find((m: any) => m.role === 'system');
  if (systemMsg) {
    const sysContent = extractTextContent(systemMsg.content);
    if (sysContent) {
      cleanMessages.push({ role: 'system', content: sysContent });
    }
  }

  // Find the last user message
  const userMessages = requestMessages.filter((m: any) => m.role === 'user');
  const lastUserMsg = userMessages[userMessages.length - 1];
  if (lastUserMsg) {
    const userContent = extractTextContent(lastUserMsg.content);
    if (userContent) {
      cleanMessages.push({ role: 'user', content: userContent });
    }
  }

  // Add the assistant response
  cleanMessages.push({ role: 'assistant', content: assistantContent });

  // Need at least user + assistant to be useful training data
  if (cleanMessages.filter(m => m.role === 'user').length === 0) return;
  if (cleanMessages.filter(m => m.role === 'assistant').length === 0) return;

  const entry = { messages: cleanMessages };

  try {
    const feedbackDir = getFeedbackQueueDir();
    fs.mkdirSync(feedbackDir, { recursive: true });

    // One file per day so we don't get thousands of tiny files
    const dateStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const filePath = path.join(feedbackDir, `conversations-${dateStr}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(entry) + '\n', { encoding: 'utf-8' });
  } catch (err) {
    console.error('[LLMConversationFileLogger] Failed to write training entry:', err);
  }
}

/**
 * Called on every log event. On request: stashes messages. On response: pairs
 * with stashed request and writes training data.
 */
function handleTrainingCapture(event: LLMLogEvent): void {
  const convKey = event.conversationId || 'default';

  if (event.direction === 'request') {
    // Stash the messages array from the request payload
    const payload = event.payload as Record<string, unknown> | null;
    if (payload?.messages && Array.isArray(payload.messages)) {
      pendingRequests.set(convKey, payload.messages as Record<string, unknown>[]);
    }
    return;
  }

  if (event.direction === 'response') {
    const requestMessages = pendingRequests.get(convKey);
    if (!requestMessages) return;

    // Extract assistant content from the response
    const payload = event.payload as Record<string, unknown> | null;
    const choices = (payload?.choices as any[]) ?? [];
    const firstChoice = choices[0];
    if (!firstChoice?.message) return;

    const msg = firstChoice.message as Record<string, unknown>;

    // Skip tool_calls-only responses — they aren't useful training data
    if (msg.tool_calls && !msg.content) return;
    if (firstChoice.finish_reason === 'tool_calls') return;

    const assistantContent = extractTextContent(msg.content);

    // Strip <thinking> tags — we only want the actual response
    const cleaned = assistantContent
      .replace(/<thinking>[\s\S]*?<\/thinking>/g, '')
      .trim();

    writeTrainingEntry(requestMessages, cleaned);

    // Clean up stash
    pendingRequests.delete(convKey);
  }
}

function isEnabled(): boolean {
  return true;
}

function sanitizeToken(value: string): string {
  return value
    .trim()
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 120) || 'default';
}

function getLogFilePath(conversationId?: string): string {
  const fileToken = sanitizeToken(conversationId || 'default');

  fs.mkdirSync(PROJECT_LOG_DIR, { recursive: true });
  return path.join(PROJECT_LOG_DIR, `${LOG_FILE_PREFIX}-${fileToken}.log`);
}

function serializePayload(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2);
  } catch {
    return String(payload);
  }
}

function sanitizeEventPayload(event: LLMLogEvent): unknown {
  if (event.direction !== 'request') {
    return event.payload;
  }

  if (!event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload)) {
    return event.payload;
  }

  const payload = { ...(event.payload as Record<string, unknown>) };

  if ('tools' in payload) {
    delete payload.tools;
  }

  return payload;
}

export function writeLLMConversationEvent(event: LLMLogEvent): void {
  if (!isEnabled()) {
    return;
  }

  try {
    const filePath = getLogFilePath(event.conversationId);
    const lines = [
      '---',
      `timestamp: ${new Date().toISOString()}`,
      `direction: ${event.direction}`,
      `provider: ${event.provider}`,
      `model: ${event.model || 'unknown'}`,
      `endpoint: ${event.endpoint || 'unknown'}`,
      `nodeName: ${event.nodeName || 'unknown'}`,
      `conversationId: ${event.conversationId || 'default'}`,
      `attempt: ${typeof event.attempt === 'number' ? event.attempt : 'n/a'}`,
      'payload:',
      serializePayload(sanitizeEventPayload(event)),
      '',
    ];

    fs.appendFileSync(filePath, `${lines.join('\n')}\n`, { encoding: 'utf-8' });

    // Also capture for training data
    handleTrainingCapture(event);
  } catch (error) {
    console.error('[LLMConversationFileLogger] Failed to write event:', error);
  }
}
