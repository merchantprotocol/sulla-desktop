/**
 * Shared helpers for the `ask_user_question` capability.
 *
 * Two call-sites use these:
 *   1. The in-process BaseTool `ask_user_question` (ask_user_question.ts),
 *      invoked when any model in our own agent loop (Anthropic, OpenAI,
 *      Google, …) emits the tool call.
 *   2. The `ask_user_question` MCP tool (MCPServerHost.ts), invoked by
 *      claude-code's inner loop — Claude's native AskUserQuestion is
 *      disallowed so it reciprocates through ours instead.
 *
 * Both normalize the model's input into a `UserQuestion[]`, emit a
 * `tool_question` chat card (which the renderer turns into an interactive
 * ToolQuestion.vue), park a promise in ApprovalService, and format the
 * user's answer back into a deterministic string the model can branch on.
 */

import type {
  UserQuestion,
  UserQuestionOption,
  UserQuestionResolution,
} from '@pkg/agent/services/ApprovalService';
import { getWebSocketClientService } from '@pkg/agent/services/WebSocketClientService';

export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
export const MIN_TIMEOUT_MS = 5 * 1000;
export const MAX_TIMEOUT_MS = 30 * 60 * 1000;

const DEFAULT_WS_CHANNEL = 'heartbeat';

/** Clamp a caller-supplied timeout into the allowed band, falling back to
 *  the default when absent or non-numeric. */
export function clampTimeout(raw: unknown): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0
    ? Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, n))
    : DEFAULT_TIMEOUT_MS;
}

/**
 * Coerce loose model output into a validated `UserQuestion[]`. Accepts the
 * canonical `{ questions: [...] }` shape and is forgiving about types
 * (strings, missing headers, etc.). Returns an error string when nothing
 * usable could be extracted so the caller can return a tool error.
 */
export function normalizeQuestions(input: any): { questions: UserQuestion[]; error?: string } {
  const rawList: any[] = Array.isArray(input?.questions)
    ? input.questions
    : Array.isArray(input)
      ? input
      : [];

  if (rawList.length === 0) {
    return { questions: [], error: 'ask_user_question: `questions` must be a non-empty array.' };
  }

  const questions: UserQuestion[] = [];
  for (const q of rawList.slice(0, 4)) {
    const question = typeof q?.question === 'string' ? q.question.trim() : '';
    if (!question) continue;

    const header = typeof q?.header === 'string' && q.header.trim() ? q.header.trim() : undefined;
    const multiSelect = q?.multiSelect === true;

    const rawOptions: any[] = Array.isArray(q?.options) ? q.options : [];
    const options: UserQuestionOption[] = [];
    for (const o of rawOptions.slice(0, 8)) {
      // Allow both { label, description } objects and bare strings.
      if (typeof o === 'string') {
        const label = o.trim();
        if (label) options.push({ label });
        continue;
      }
      const label = typeof o?.label === 'string' ? o.label.trim() : '';
      if (!label) continue;
      const description = typeof o?.description === 'string' && o.description.trim()
        ? o.description.trim()
        : undefined;
      options.push({ label, description });
    }

    if (options.length === 0) continue;
    questions.push({ question, header, multiSelect, options });
  }

  if (questions.length === 0) {
    return { questions: [], error: 'ask_user_question: every question needs `question` text and at least one option.' };
  }

  return { questions };
}

/**
 * Emit a `tool_question` chat card directly over the WebSocket bus. Used by
 * the MCP path, which runs in the main process and has a BaseThreadState but
 * not a BaseTool's injected `sendChatMessage`. The in-process tool uses
 * `this.emitMessage(...)` instead (same wire shape).
 */
export async function emitQuestionCardViaWs(
  wsChannel:  string | undefined,
  threadId:   string | undefined,
  questionId: string,
  questions:  UserQuestion[],
): Promise<boolean> {
  const connectionId = wsChannel || DEFAULT_WS_CHANNEL;
  try {
    const ws = getWebSocketClientService();
    return await ws.send(connectionId, {
      type: 'assistant_message',
      data: {
        content:   '',
        role:      'assistant',
        kind:      'tool_question',
        thread_id: threadId,
        timestamp: Date.now(),
        toolQuestion: { questionId, questions },
      },
    });
  } catch {
    return false;
  }
}

/**
 * Render the user's resolution into a compact, deterministic string the
 * model can read back. Timeouts are reported explicitly so the model knows
 * no choice was made.
 */
export function formatQuestionResolution(
  questions:  UserQuestion[],
  resolution: UserQuestionResolution,
  timeoutMs:  number,
): string {
  if (resolution.status === 'timed_out') {
    return `User did not answer within ${ Math.round(timeoutMs / 1000) }s. No selection was made — proceed with your best judgment or ask again.`;
  }

  if (!resolution.answers.length) {
    return 'User dismissed the question without selecting anything.';
  }

  const lines = resolution.answers.map((a) => {
    const label = a.question || 'Question';
    const picked = a.selected.length ? a.selected.join(', ') : '(no selection)';
    return `- ${ label }: ${ picked }`;
  });

  return ['User answered:', ...lines].join('\n');
}
