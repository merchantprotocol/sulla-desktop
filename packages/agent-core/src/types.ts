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

/** `irreversible` = sends, posts, pays or deletes (Jonathon's rule, memory Yhd3). */
export type ToolSideEffect = 'read' | 'write' | 'irreversible';

/** A host that may run a tool. */
export type ToolPlacement = 'desktop' | 'cloud' | 'mobile';

/** Credential custody a tool needs (PLAN.md §4.1). */
export type ToolCredential = 'none' | { integration: string } | { vaultItem: true };

/**
 * Placement metadata a tool manifest publishes (PLAN.md §4.1). This is the
 * canonical definition: Desktop's `toolPlacement.ts` and the generated
 * `tool-placements.json` use these exact shapes. `placements` lists the
 * hosts that are allowed to run the tool; a host only offers it if it also
 * implements it.
 */
export interface ToolPlacementMetadata {
  placements: ToolPlacement[];
  /** May a phone or Cloud loop relay the call to an online Desktop? */
  relayable:  boolean;
  sideEffect: ToolSideEffect;
  credential: ToolCredential;
}

/**
 * Canonical tool id: `<category>/<manifest name>`, e.g. `web/web_search` or
 * `github/github_create_pr`. ToolSpec names, `tool-placements.json` keys and
 * runtime-protocol calls all use this form.
 */
export function toolId(category: string, name: string): string {
  return `${ category }/${ name }`;
}

/** Splits a canonical tool id. Returns null when there is no category. */
export function parseToolId(id: string): { category: string; name: string } | null {
  const slash = id.indexOf('/');
  if (slash <= 0 || slash === id.length - 1) return null;
  return { category: id.slice(0, slash), name: id.slice(slash + 1) };
}

/**
 * A tool the model may call. `name` is the canonical tool id
 * (`web/web_search`); adapters send a provider-safe wire name (see
 * `wireToolName`).
 */
export interface ToolSpec {
  name:              string;
  description:       string;
  inputSchema?:      JsonSchema;
  /**
   * Required. Anything other than `read` or `write` (including a missing
   * value from untyped callers) is treated as irreversible and needs a tap.
   */
  sideEffect:        ToolSideEffect;
  /**
   * Set by the host when this call needs a tap even though `sideEffect` alone
   * wouldn't ask, e.g. a relayed `write` (PLAN.md §4.4). See
   * `requiresApprovalFor`. It can add a gate, never remove one.
   */
  requiresApproval?: boolean;
  placements?:       ToolPlacement[];
  relayable?:        boolean;
  credential?:       ToolCredential;
}

/** Does this call need a human tap before it runs? Fails closed. */
export function needsApproval(spec: Pick<ToolSpec, 'sideEffect' | 'requiresApproval'>): boolean {
  if (spec.requiresApproval === true) return true;
  return spec.sideEffect !== 'read' && spec.sideEffect !== 'write';
}

/**
 * The host-side rule for `ToolSpec.requiresApproval`: irreversible calls
 * always need a tap, and so does any relayed call that isn't a read
 * (PLAN.md §4.4).
 */
export function requiresApprovalFor(meta: { sideEffect: ToolSideEffect; relayed?: boolean }): boolean {
  if (meta.sideEffect !== 'read' && meta.sideEffect !== 'write') return true;
  return meta.relayed === true && meta.sideEffect !== 'read';
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

/**
 * Token usage with the same meaning for every provider. `inputTokens` is the
 * whole prompt, including cache reads and cache writes (OpenAI's
 * `prompt_tokens`; Anthropic's `input_tokens + cache_read_input_tokens +
 * cache_creation_input_tokens`). `cachedTokens` (cache reads) and
 * `cacheWriteTokens` are subsets of `inputTokens`, for pricing.
 */
export interface Usage {
  inputTokens:      number;
  outputTokens:     number;
  cachedTokens:     number;
  cacheWriteTokens: number;
}

/** One model reply, mapped from any provider. */
export interface NormalizedResponse {
  /** Plain text of the reply. */
  content:      string;
  /** Assistant content to append to the transcript (text + tool_use). */
  blocks:       ContentBlock[];
  toolCalls:    ToolCall[];
  /**
   * The provider's real stop reason. `length` (or `content_filter`) wins
   * over `tool_calls`: a tool call in a cut-off reply may be incomplete.
   */
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

export type TurnStatus = 'completed' | 'max_iterations' | 'token_budget' | 'aborted' | 'provider_error' | 'checkpoint_failed';

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 };
}

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens:      a.inputTokens + b.inputTokens,
    outputTokens:     a.outputTokens + b.outputTokens,
    cachedTokens:     a.cachedTokens + b.cachedTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
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
