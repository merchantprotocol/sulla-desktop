// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * One agent turn: call the model, normalize its tool calls, enforce the
 * allowlist and approvals, run tools through the host, append results,
 * repeat until the model stops or a guard trips.
 *
 * Invariant: every tool_use the model emits gets exactly one tool result in
 * the transcript, even when a guard stops the turn, so the transcript can
 * always be sent to any provider again.
 */

import { ProviderError } from './providers/types.js';
import { buildToolIndex, formatToolResult, resolveToolCall, validateParams, wireToolName } from './toolCalls.js';
import { addUsage, emptyUsage } from './types.js';

import type { AbortSignalLike, AgentHost, HttpRequest } from './host.js';
import type { ProviderAdapter } from './providers/types.js';
import type { ResolvedCall } from './toolCalls.js';
import type { ChatMessage, ContentBlock, NormalizedResponse, StreamEvent, ToolCall, ToolSpec, TurnStatus, Usage } from './types.js';

/** Matches Desktop's `MAX_CONSECTUIVE_LOOP` in `agent/nodes/Graph.ts`. */
export const DEFAULT_MAX_ITERATIONS = 40;

export interface TurnBudget {
  /** Model calls per turn. Default 40. */
  maxIterations?:   number;
  /** Input + output tokens across the turn; the turn stops once exceeded. */
  maxTotalTokens?:  number;
  maxOutputTokens?: number;
}

export interface RunTurnOptions {
  runId:        string;
  providerId:   string;
  model:        string;
  adapter:      ProviderAdapter;
  system?:      string;
  messages:     ChatMessage[];
  tools:        ToolSpec[];
  host:         AgentHost;
  budget?:      TurnBudget;
  temperature?: number;
  signal?:      AbortSignalLike;
  onEvent?:     (event: StreamEvent) => void;
}

export interface RunTurnResult {
  status:      TurnStatus;
  /** Full transcript: input messages plus everything this turn added. */
  messages:    ChatMessage[];
  newMessages: ChatMessage[];
  finalText:   string;
  iterations:  number;
  usage:       Usage;
  error?:      { code: string; message: string; status?: number };
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function toolMessage(call: ToolCall, content: string, isError: boolean): ChatMessage {
  const msg: ChatMessage = { role: 'tool', tool_call_id: call.id, name: call.name, content };
  if (isError) msg.metadata = { isError: true };
  return msg;
}

export async function runTurn(options: RunTurnOptions): Promise<RunTurnResult> {
  const { host, adapter, signal } = options;
  const maxIterations = Math.max(1, options.budget?.maxIterations ?? DEFAULT_MAX_ITERATIONS);
  const maxTotalTokens = options.budget?.maxTotalTokens;
  const index = buildToolIndex(options.tools);
  const now = () => (host.clock ? host.clock.now() : 0);
  const emit = (event: StreamEvent) => {
    if (options.onEvent) options.onEvent(event);
  };
  const transport = (request: HttpRequest, s?: AbortSignalLike) => host.keyBroker.fetch(options.providerId, request, s);

  const messages = clone(options.messages);
  const startLength = messages.length;
  let usage = emptyUsage();
  let iterations = 0;
  let finalText = '';

  const checkpoint = async() => {
    if (host.checkpoint) await host.checkpoint.save({ runId: options.runId, iteration: iterations, messages: clone(messages), usage });
  };
  const finish = (status: TurnStatus, error?: RunTurnResult['error']): RunTurnResult => {
    emit({ type: 'done', status });
    const result: RunTurnResult = {
      status,
      messages,
      newMessages: messages.slice(startLength),
      finalText,
      iterations,
      usage,
    };
    if (error) result.error = error;
    return result;
  };
  const tokensUsed = () => usage.inputTokens + usage.outputTokens;

  for (;;) {
    if (signal?.aborted) return finish('aborted');
    if (iterations >= maxIterations) return finish('max_iterations');
    if (maxTotalTokens !== undefined && tokensUsed() >= maxTotalTokens) return finish('token_budget');

    iterations++;
    emit({ type: 'model_request', iteration: iterations });
    const started = now();
    let response: NormalizedResponse;
    try {
      response = await adapter.complete({
        model:           options.model,
        system:          options.system,
        messages,
        tools:           options.tools,
        maxOutputTokens: options.budget?.maxOutputTokens,
        temperature:     options.temperature,
      }, transport, signal);
    } catch (err) {
      if (signal?.aborted) return finish('aborted');
      // Provider errors end the turn with a plain message; the loop never retries them.
      const e = err instanceof ProviderError ? err : new ProviderError(String((err as Error)?.message ?? err), 0, 'adapter');
      return finish('provider_error', { code: e.code, message: e.message, status: e.status });
    }
    usage = addUsage(usage, response.usage);
    emit({ type: 'usage', usage: response.usage, durationMs: Math.max(0, now() - started) });
    if (response.content) emit({ type: 'text', text: response.content });

    // Resolve once, and store the canonical wire name so a slip like
    // "functions.web__web_search" is not replayed to the provider.
    const resolved = new Map<string, ResolvedCall>();
    for (const call of response.toolCalls) resolved.set(call.id, resolveToolCall(call, index));
    const blocks = response.blocks.map((b): ContentBlock => {
      const r = b.type === 'tool_use' ? resolved.get(b.id) : undefined;
      if (b.type !== 'tool_use' || !r || r.kind !== 'dispatch' || b.name.trim() === 'exec') return b;
      return { ...b, name: wireToolName(r.spec.name) };
    });
    messages.push({ role: 'assistant', content: blocks.length ? blocks : response.content });
    if (response.content) finalText = response.content;
    await checkpoint();

    if (!response.toolCalls.length) return finish('completed');

    let stopReason: TurnStatus | null = null;
    for (const call of response.toolCalls) {
      emit({ type: 'tool_call', call });
      if (!stopReason && signal?.aborted) stopReason = 'aborted';
      if (!stopReason && maxTotalTokens !== undefined && tokensUsed() >= maxTotalTokens) stopReason = 'token_budget';
      if (stopReason) {
        messages.push(toolMessage(call, `Not run: the turn stopped (${ stopReason }).`, true));
        emit({ type: 'tool_result', id: call.id, name: call.name, success: false });
        continue;
      }
      const { content, success } = await runOneTool(call, resolved.get(call.id) ?? resolveToolCall(call, index), options);
      messages.push(toolMessage(call, content, !success));
      emit({ type: 'tool_result', id: call.id, name: call.name, success });
      await checkpoint();
    }
    if (stopReason) {
      await checkpoint();
      return finish(stopReason);
    }
  }
}

async function runOneTool(call: ToolCall, resolved: ResolvedCall, options: RunTurnOptions): Promise<{ content: string; success: boolean }> {
  if (resolved.kind === 'error') return { content: `Error: ${ resolved.message }`, success: false };

  const validation = validateParams(resolved.spec.inputSchema, resolved.args);
  if (!validation.ok) return { content: `Error: ${ validation.error }`, success: false };

  const request = { id: call.id, name: resolved.spec.name, args: validation.params };
  const toolHost = options.host.toolHost;
  if (resolved.spec.sideEffect === 'irreversible') {
    if (!toolHost.approve) {
      return { content: `Error: "${ resolved.spec.name }" needs the user's approval and this device can't ask for it.`, success: false };
    }
    let approved = false;
    try {
      approved = await toolHost.approve(request, resolved.spec);
    } catch {
      approved = false;
    }
    if (!approved) return { content: `Error: the user did not approve "${ resolved.spec.name }".`, success: false };
  }

  try {
    const result = await toolHost.invoke(request, { runId: options.runId, signal: options.signal });
    if (result.success) return { content: formatToolResult(result.result ?? null), success: true };
    const err = result.error ?? { code: 'tool_error', message: 'Tool failed' };
    return { content: formatToolResult(`Error (${ err.code }): ${ err.message }`), success: false };
  } catch (err) {
    return { content: `Error (tool_exception): ${ String((err as Error)?.message ?? err) }`, success: false };
  }
}
