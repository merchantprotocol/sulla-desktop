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

import { bodyError, parseSseJson, sendJson, sendStream } from './types.js';

import type { ProviderAdapter, ProviderCallInput } from './types.js';
import type { ContentBlock, FinishReason, NormalizedResponse, ToolCall } from '../types.js';

export interface OpenAIChatOptions {
  baseUrl?:        string;
  /**
   * Field that carries the output limit. OpenAI reasoning models (o-series,
   * GPT-5) reject `max_tokens` and need `max_completion_tokens`; many
   * compatible servers only know `max_tokens`. Default `max_tokens`.
   */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
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
  const maxTokensField = options.maxTokensField ?? 'max_tokens';

  const adapter: ProviderAdapter = {
    api: 'openai-chat',

    buildRequest(input: ProviderCallInput, callOptions: { stream?: boolean } = {}) {
      const body: Record<string, unknown> = {
        model:    input.model,
        messages: toWireMessages(input),
      };
      if (input.maxOutputTokens !== undefined) body[maxTokensField] = input.maxOutputTokens;
      if (input.temperature !== undefined) body.temperature = input.temperature;
      if (callOptions.stream) {
        body.stream = true;
        body.stream_options = { include_usage: true };
      }
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
      // OpenRouter reports upstream failures inside the choice.
      if (choice.error) throw bodyError({ error: choice.error }, 0);
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
      const stop = mapFinishReason(choice.finish_reason);
      const response: NormalizedResponse = {
        content,
        blocks,
        toolCalls,
        finishReason: stop === 'length' || stop === 'content_filter' || !toolCalls.length ? stop : 'tool_calls',
        usage:        {
          // prompt_tokens already includes cached tokens.
          inputTokens:      Number(usage.prompt_tokens ?? 0) || 0,
          outputTokens:     Number(usage.completion_tokens ?? 0) || 0,
          cachedTokens:     Number(usage.prompt_tokens_details?.cached_tokens ?? 0) || 0,
          cacheWriteTokens: 0,
        },
      };
      if (typeof body.model === 'string') response.model = body.model;
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) response.reasoning = message.reasoning_content;
      return response;
    },

    async complete(input, transport, signal) {
      return adapter.parseResponse(await sendJson(adapter.buildRequest(input), transport, signal));
    },

    async stream(input, transport, onText, signal) {
      const acc = createStreamAccumulator(onText);
      await sendStream(adapter.buildRequest(input, { stream: true }), transport, ev => acc.chunk(parseSseJson(ev.data)), signal);
      return adapter.parseResponse(acc.body());
    },
  };
  return adapter;
}

/**
 * Rebuilds a non-streaming Chat Completions body from stream chunks, so
 * streamed and plain replies go through the same parseResponse.
 */
function createStreamAccumulator(onText: (text: string) => void) {
  const out: Record<string, any> = {};
  let content = '';
  let reasoning = '';
  let finishReason: unknown;
  let choiceError: unknown;
  const calls: { id?: string; name: string; arguments: string }[] = [];

  return {
    chunk(c: any) {
      if (!c || typeof c !== 'object') return;
      if (c.error) throw bodyError(c, 0);
      if (typeof c.model === 'string') out.model = c.model;
      if (c.usage) out.usage = c.usage;
      const choice = Array.isArray(c.choices) ? c.choices[0] : undefined;
      if (!choice) return;
      if (choice.error) choiceError = choice.error;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const d = choice.delta ?? {};
      if (typeof d.content === 'string' && d.content) {
        content += d.content;
        onText(d.content);
      }
      if (typeof d.reasoning_content === 'string') reasoning += d.reasoning_content;
      for (const tc of Array.isArray(d.tool_calls) ? d.tool_calls : []) {
        const i = typeof tc?.index === 'number' ? tc.index : calls.length;
        const call = calls[i] ?? (calls[i] = { name: '', arguments: '' });
        if (tc.id) call.id = tc.id;
        if (typeof tc.function?.name === 'string') call.name += tc.function.name;
        if (typeof tc.function?.arguments === 'string') call.arguments += tc.function.arguments;
      }
    },
    body() {
      const message: Record<string, unknown> = { role: 'assistant', content };
      if (reasoning) message.reasoning_content = reasoning;
      const toolCalls = calls.filter(Boolean).map(c => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }));
      if (toolCalls.length) message.tool_calls = toolCalls;
      // A stream that ends with no finish_reason was cut off.
      const choice: Record<string, unknown> = { finish_reason: finishReason ?? 'length', message };
      if (choiceError) choice.error = choiceError;
      return { ...out, choices: [choice] };
    },
  };
}
