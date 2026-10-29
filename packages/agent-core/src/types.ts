// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Portable message, tool and response types for the Sulla agent loop.
 *
 * Shapes match Desktop's `BaseLanguageModel.ts` (ChatMessage, ContentBlock,
 * FinishReason values) and `@sulla/runtime-protocol` (ToolResult) so the
 * same transcript can move between Desktop, Mobile and Cloud. They're
 * redeclared here, not imported, because this package must build with no
 * Node, React Native or Workers types.
 */

/** Content blocks in Anthropic's native shape, as Desktop stores them. */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | ContentBlock[]; is_error?: boolean }
  | { type: 'thinking'; thinking: string };

export interface ChatMessage {
  id?:           string;
  role:          'user' | 'assistant' | 'system' | 'tool';
  content:       string | ContentBlock[];
  name?:         string;
  tool_call_id?: string;
  timestamp?:    number;
  metadata?:     Record<string, any>;
}

/** Same string values as Desktop's `FinishReason` enum, plus `other`. */
export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export interface JsonSchema {
  type?:        string;
  description?: string;
  enum?:        string[];
  items?:       JsonSchema;
  properties?:  Record<string, JsonSchema>;
  required?:    string[];
}

export type ToolSideEffect = 'read' | 'write' | 'irreversible';

/**
 * A tool the model may call. `name` may contain `/` (`web/web_search`);
 * adapters send a provider-safe wire name (see `wireToolName`).
 */
export interface ToolSpec {
  name:         string;
  description:  string;
  inputSchema?: JsonSchema;
  /** `irreversible` (sends, posts, pays, deletes) always needs host approval. */
  sideEffect?:  ToolSideEffect;
}

/** A tool call as the model produced it, before normalization. */
export interface ToolCall {
  id:   string;
  name: string;
  /** Parsed object, or the raw string when the provider sent invalid JSON. */
  args: unknown;
}

/** Structurally identical to `@sulla/runtime-protocol` ToolResult. */
export interface ToolResult {
  success: boolean;
  result?: unknown;
  error?:  { code: string; message: string; details?: unknown };
}

export interface Usage {
  inputTokens:  number;
  outputTokens: number;
  cachedTokens: number;
}

/** One model reply, mapped from any provider. */
export interface NormalizedResponse {
  /** Plain text of the reply. */
  content:      string;
  /** Assistant content to append to the transcript (text + tool_use). */
  blocks:       ContentBlock[];
  toolCalls:    ToolCall[];
  finishReason: FinishReason;
  usage:        Usage;
  model?:       string;
  reasoning?:   string;
}

export type StreamEvent =
  | { type: 'model_request'; iteration: number }
  | { type: 'text_delta'; text: string }
  | { type: 'text'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; name: string; success: boolean }
  | { type: 'usage'; usage: Usage; durationMs: number }
  | { type: 'done'; status: TurnStatus };

export type TurnStatus = 'completed' | 'max_iterations' | 'token_budget' | 'aborted' | 'provider_error';

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens:  a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedTokens: a.cachedTokens + b.cachedTokens,
  };
}

/** Plain text of a message's content (string or blocks). */
export function getTextContent(content: string | ContentBlock[]): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content ?? '');
  return content
    .filter((b): b is { type: 'text'; text: string } => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('\n');
}
