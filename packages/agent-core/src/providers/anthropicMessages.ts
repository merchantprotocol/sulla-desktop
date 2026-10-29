// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Anthropic Messages API adapter (`POST /v1/messages`). The host's
 * KeyBroker adds `x-api-key`; this adapter only sets the version header.
 */

import { parseToolArguments, sanitizeSchema, wireToolName } from '../toolCalls.js';
import { getTextContent } from '../types.js';

import { sendJson } from './types.js';

import type { ProviderAdapter, ProviderCallInput } from './types.js';
import type { ContentBlock, FinishReason, NormalizedResponse, ToolCall } from '../types.js';

export interface AnthropicMessagesOptions {
  baseUrl?: string;
  version?: string;
}

const DEFAULT_MAX_TOKENS = 4096;

type WireBlock = Record<string, unknown>;
interface WireMessage { role: 'user' | 'assistant'; content: WireBlock[] }

function toWireBlocks(content: string | ContentBlock[]): WireBlock[] {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : [];
  const out: WireBlock[] = [];
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text) out.push({ type: 'text', text: b.text });
    } else if (b.type === 'tool_use') {
      out.push({ type: 'tool_use', id: b.id, name: wireToolName(b.name), input: b.input ?? {} });
    } else if (b.type === 'tool_result') {
      const block: WireBlock = { type: 'tool_result', tool_use_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : getTextContent(b.content) };
      if (b.is_error) block.is_error = true;
      out.push(block);
    } else if (b.type === 'image') {
      out.push({ type: 'image', source: b.source });
    }
    // Thinking blocks are not replayed: they need provider signatures.
  }
  return out;
}

function pushMessage(out: WireMessage[], role: 'user' | 'assistant', blocks: WireBlock[]): void {
  if (!blocks.length) return;
  const last = out[out.length - 1];
  // The API requires alternating roles; merge consecutive same-role turns.
  if (last && last.role === role) last.content.push(...blocks);
  else out.push({ role, content: blocks });
}

function mapStopReason(reason: unknown): FinishReason {
  switch (reason) {
  case 'end_turn':
  case 'stop_sequence':
    return 'stop';
  case 'tool_use':
    return 'tool_calls';
  case 'max_tokens':
    return 'length';
  case 'refusal':
    return 'content_filter';
  default:
    return 'other';
  }
}

export function createAnthropicMessagesAdapter(options: AnthropicMessagesOptions = {}): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? 'https://api.anthropic.com').replace(/\/+$/, '');
  const version = options.version ?? '2023-06-01';

  const adapter: ProviderAdapter = {
    api: 'anthropic-messages',

    buildRequest(input: ProviderCallInput) {
      const systemParts: string[] = input.system ? [input.system] : [];
      const messages: WireMessage[] = [];
      for (const m of input.messages) {
        if (m.role === 'system') {
          const text = getTextContent(m.content);
          if (text) systemParts.push(text);
        } else if (m.role === 'tool') {
          const block: WireBlock = { type: 'tool_result', tool_use_id: m.tool_call_id ?? '', content: getTextContent(m.content) };
          if (m.metadata?.isError) block.is_error = true;
          pushMessage(messages, 'user', [block]);
        } else {
          pushMessage(messages, m.role, toWireBlocks(m.content));
        }
      }
      const body: Record<string, unknown> = {
        model:      input.model,
        max_tokens: input.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        messages,
      };
      if (systemParts.length) body.system = systemParts.join('\n\n');
      if (input.temperature !== undefined) body.temperature = input.temperature;
      if (input.tools.length) {
        body.tools = input.tools.map(t => ({
          name:         wireToolName(t.name),
          description:  t.description,
          input_schema: sanitizeSchema(t.inputSchema),
        }));
      }
      return {
        url:     `${ baseUrl }/v1/messages`,
        method:  'POST',
        headers: { 'content-type': 'application/json', 'anthropic-version': version },
        body:    JSON.stringify(body),
      };
    },

    parseResponse(raw: unknown): NormalizedResponse {
      const body = (raw ?? {}) as Record<string, any>;
      const blocks: ContentBlock[] = [];
      const toolCalls: ToolCall[] = [];
      const text: string[] = [];
      const reasoning: string[] = [];
      for (const b of Array.isArray(body.content) ? body.content : []) {
        if (b?.type === 'text' && typeof b.text === 'string') {
          text.push(b.text);
          blocks.push({ type: 'text', text: b.text });
        } else if (b?.type === 'tool_use') {
          const args = parseToolArguments(b.input);
          toolCalls.push({ id: String(b.id ?? ''), name: String(b.name ?? ''), args });
          blocks.push({ type: 'tool_use', id: String(b.id ?? ''), name: String(b.name ?? ''), input: args });
        } else if (b?.type === 'thinking' && typeof b.thinking === 'string') {
          reasoning.push(b.thinking);
        }
      }
      const usage = body.usage ?? {};
      const response: NormalizedResponse = {
        content:      text.join(''),
        blocks,
        toolCalls,
        finishReason: toolCalls.length ? 'tool_calls' : mapStopReason(body.stop_reason),
        usage:        {
          inputTokens:  Number(usage.input_tokens ?? 0) || 0,
          outputTokens: Number(usage.output_tokens ?? 0) || 0,
          cachedTokens: Number(usage.cache_read_input_tokens ?? 0) || 0,
        },
      };
      if (typeof body.model === 'string') response.model = body.model;
      if (reasoning.length) response.reasoning = reasoning.join('\n');
      return response;
    },

    async complete(input, transport, signal) {
      return adapter.parseResponse(await sendJson(adapter.buildRequest(input), transport, signal));
    },
  };
  return adapter;
}
