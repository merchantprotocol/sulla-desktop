// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * OpenAI Chat Completions adapter (`POST {baseUrl}/chat/completions`).
 * Also serves the compatible APIs (xAI, OpenRouter, Groq, Together,
 * DeepSeek, Mistral, Ollama, custom) by changing `baseUrl`. The host's
 * KeyBroker adds the `Authorization` header.
 */

import { parseToolArguments, sanitizeSchema, wireToolName } from '../toolCalls.js';
import { getTextContent } from '../types.js';

import { sendJson } from './types.js';

import type { ProviderAdapter, ProviderCallInput } from './types.js';
import type { ContentBlock, FinishReason, NormalizedResponse, ToolCall } from '../types.js';

export interface OpenAIChatOptions {
  baseUrl?: string;
}

type WireMessage = Record<string, unknown>;

function mapFinishReason(reason: unknown): FinishReason {
  switch (reason) {
  case 'stop':
    return 'stop';
  case 'tool_calls':
  case 'function_call':
    return 'tool_calls';
  case 'length':
    return 'length';
  case 'content_filter':
    return 'content_filter';
  default:
    return 'other';
  }
}

function toWireMessages(input: ProviderCallInput): WireMessage[] {
  const out: WireMessage[] = [];
  if (input.system) out.push({ role: 'system', content: input.system });
  for (const m of input.messages) {
    if (m.role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id ?? '', content: getTextContent(m.content) });
      continue;
    }
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const text = getTextContent(m.content);
    if (m.role === 'assistant') {
      const toolCalls = m.content
        .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
        .map(b => ({
          id:       b.id,
          type:     'function',
          function: { name: wireToolName(b.name), arguments: typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? {}) },
        }));
      const wire: WireMessage = { role: 'assistant', content: text || null };
      if (toolCalls.length) wire.tool_calls = toolCalls;
      out.push(wire);
      continue;
    }
    // Tool results stored as user blocks (Anthropic style) become tool messages.
    const results = m.content.filter((b): b is Extract<ContentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
    for (const r of results) {
      out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: typeof r.content === 'string' ? r.content : getTextContent(r.content) });
    }
    const images = m.content.filter((b): b is Extract<ContentBlock, { type: 'image' }> => b.type === 'image');
    if (images.length) {
      const parts: Record<string, unknown>[] = text ? [{ type: 'text', text }] : [];
      for (const img of images) {
        parts.push({ type: 'image_url', image_url: { url: `data:${ img.source.media_type };base64,${ img.source.data }` } });
      }
      out.push({ role: m.role, content: parts });
    } else if (text || !results.length) {
      out.push({ role: m.role, content: text });
    }
  }
  return out;
}

export function createOpenAIChatAdapter(options: OpenAIChatOptions = {}): ProviderAdapter {
  const baseUrl = (options.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');

  const adapter: ProviderAdapter = {
    api: 'openai-chat',

    buildRequest(input: ProviderCallInput) {
      const body: Record<string, unknown> = {
        model:    input.model,
        messages: toWireMessages(input),
      };
      if (input.maxOutputTokens !== undefined) body.max_tokens = input.maxOutputTokens;
      if (input.temperature !== undefined) body.temperature = input.temperature;
      if (input.tools.length) {
        body.tools = input.tools.map(t => ({
          type:     'function',
          function: {
            name:        wireToolName(t.name),
            description: t.description,
            parameters:  sanitizeSchema(t.inputSchema),
          },
        }));
      }
      return {
        url:     `${ baseUrl }/chat/completions`,
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      };
    },

    parseResponse(raw: unknown): NormalizedResponse {
      const body = (raw ?? {}) as Record<string, any>;
      const choice = Array.isArray(body.choices) ? body.choices[0] ?? {} : {};
      const message = choice.message ?? {};
      const content = typeof message.content === 'string' ? message.content : '';
      const blocks: ContentBlock[] = content ? [{ type: 'text', text: content }] : [];
      const toolCalls: ToolCall[] = [];
      const rawCalls: any[] = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      // Legacy single function_call shape, still sent by some compatible servers.
      if (!rawCalls.length && message.function_call) rawCalls.push({ id: 'call_0', function: message.function_call });
      rawCalls.forEach((c, i) => {
        const id = String(c?.id || `call_${ i }`);
        const name = String(c?.function?.name ?? '');
        const args = parseToolArguments(c?.function?.arguments);
        toolCalls.push({ id, name, args });
        blocks.push({ type: 'tool_use', id, name, input: args });
      });
      const usage = body.usage ?? {};
      const response: NormalizedResponse = {
        content,
        blocks,
        toolCalls,
        finishReason: toolCalls.length ? 'tool_calls' : mapFinishReason(choice.finish_reason),
        usage:        {
          inputTokens:  Number(usage.prompt_tokens ?? 0) || 0,
          outputTokens: Number(usage.completion_tokens ?? 0) || 0,
          cachedTokens: Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
        },
      };
      if (typeof body.model === 'string') response.model = body.model;
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) response.reasoning = message.reasoning_content;
      return response;
    },

    async complete(input, transport, signal) {
      return adapter.parseResponse(await sendJson(adapter.buildRequest(input), transport, signal));
    },
  };
  return adapter;
}
