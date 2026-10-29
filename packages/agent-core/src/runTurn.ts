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
 * always be sent to any provider again. Tool call ids are made unique and
 * provider-safe for the same reason.
 *
 * runTurn doesn't throw once the turn has started: a failing provider,
 * tool, approval prompt, event listener or checkpoint store ends up in the
 * result, never as an exception after a tool already ran.
 */

import { isProviderError, providerError, redactSecrets } from './providers/types.js';
import { buildToolIndex, formatToolResult, resolveToolCall, validateParams, wireToolName } from './toolCalls.js';
import { addUsage, emptyUsage, needsApproval } from './types.js';

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
  /** Errors thrown by the listener are ignored. */
  onEvent?:     (event: StreamEvent) => void;
  /**
   * Stream replies (emitting `text_delta` events) when the host's KeyBroker
   * has `stream`. Default true.
   */
  stream?:      boolean;
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

function errorText(err: unknown): string {
  return redactSecrets(String((err as Error)?.message ?? err));
}

/** Waits for `promise`, or stops waiting as soon as `signal` aborts. */
function unlessAborted<T>(promise: Promise<T>, signal?: AbortSignalLike): Promise<{ aborted: true } | { aborted: false; value: T }> {
  const s = signal;
  if (!s?.addEventListener) return promise.then(value => ({ aborted: false as const, value }));
  if (s.aborted) return Promise.resolve({ aborted: true as const });
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      s.removeEventListener?.('abort', onAbort);
      resolve({ aborted: true });
    };
    s.addEventListener?.('abort', onAbort);
    promise.then(
      (value) => {
        s.removeEventListener?.('abort', onAbort);
        resolve({ aborted: false, value });
      },
      (err) => {
        s.removeEventListener?.('abort', onAbort);
        reject(err);
      },
    );
  });
}

const SAFE_ID = /[^a-zA-Z0-9_-]/g;

/**
 * Give every tool call an id that is non-empty, provider-safe and unique in
 * the whole transcript. OpenAI-compatible servers may omit ids (the adapter
 * then falls back to `call_<index>`, which repeats every iteration), repeat
 * them within one reply, or use characters Anthropic rejects on replay.
 */
function uniqueToolIds(response: NormalizedResponse, seen: Set<string>, iteration: number): NormalizedResponse {
  if (!response.toolCalls.length) return response;
  const ids = response.toolCalls.map((call, i) => {
    let id = String(call.id ?? '').replace(SAFE_ID, '_');
    if (!id || seen.has(id)) {
      id = `call_${ iteration }_${ i }`;
      for (let n = 1; seen.has(id); n++) id = `call_${ iteration }_${ i }_${ n }`;
    }
    seen.add(id);
    return id;
  });
  let k = 0;
  return {
    ...response,
    toolCalls: response.toolCalls.map((call, i) => ({ ...call, id: ids[i] })),
    blocks:    response.blocks.map(b => (b.type === 'tool_use' && k < ids.length ? { ...b, id: ids[k++] } : b)),
  };
}

function knownToolIds(messages: ChatMessage[]): Set<string> {
  const seen = new Set<string>();
  for (const m of messages) {
    if (m.tool_call_id) seen.add(m.tool_call_id);
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') seen.add(b.id);
      else if (b.type === 'tool_result') seen.add(b.tool_use_id);
    }
  }
  return seen;
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
    try {
      if (options.onEvent) options.onEvent(event);
    } catch { /* a broken listener must not stop the turn */ }
  };
  const broker = host.keyBroker;
  const transport = (request: HttpRequest, s?: AbortSignalLike) => broker.fetch(options.providerId, request, s);
  const streamTransport = broker.stream && options.stream !== false
    ? (request: HttpRequest, onChunk: (text: string) => void, s?: AbortSignalLike) => broker.stream!(options.providerId, request, onChunk, s)
    : undefined;

  const messages = clone(options.messages);
  const startLength = messages.length;
  const seenIds = knownToolIds(messages);
  let usage = emptyUsage();
  let iterations = 0;
  let finalText = '';
  let checkpointError: string | undefined;

  /** False once a save has failed; the turn then stops at the next safe point. */
  const checkpoint = async(): Promise<boolean> => {
    if (checkpointError !== undefined) return false;
    if (!host.checkpoint) return true;
    try {
      await host.checkpoint.save({ runId: options.runId, iteration: iterations, messages: clone(messages), usage });
      return true;
    } catch (err) {
      checkpointError = errorText(err);
      return false;
    }
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
    else if (status === 'checkpoint_failed') result.error = { code: 'checkpoint_failed', message: `Could not save progress: ${ checkpointError ?? 'unknown error' }` };
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
    const input = {
      model:           options.model,
      system:          options.system,
      messages,
      tools:           options.tools,
      maxOutputTokens: options.budget?.maxOutputTokens,
      temperature:     options.temperature,
    };
    let response: NormalizedResponse;
    try {
      response = streamTransport
        ? await adapter.stream(input, streamTransport, text => emit({ type: 'text_delta', text }), signal)
        : await adapter.complete(input, transport, signal);
    } catch (err) {
      if (signal?.aborted) return finish('aborted');
      // Provider errors end the turn with a plain message; the loop never retries them.
      const e = isProviderError(err) ? err : providerError(errorText(err), 0, 'adapter');
      return finish('provider_error', { code: e.code, message: redactSecrets(e.message), status: e.status });
    }
    response = uniqueToolIds(response, seenIds, iterations);
    usage = addUsage(usage, response.usage);
    emit({ type: 'usage', usage: response.usage, durationMs: Math.max(0, now() - started) });
    if (response.content) emit({ type: 'text', text: response.content });

    // Resolve once, and store the canonical wire name so a slip like
    // "functions.web__web_search" is not replayed to the provider.
    const resolved = response.toolCalls.map(call => resolveToolCall(call, index));
    let k = 0;
    const blocks = response.blocks.map((b): ContentBlock => {
      if (b.type !== 'tool_use') return b;
      const r = resolved[k++];
      if (!r || r.kind !== 'dispatch' || b.name.trim() === 'exec') return b;
      return { ...b, name: wireToolName(r.spec.name) };
    });
    messages.push({ role: 'assistant', content: blocks.length ? blocks : response.content });
    if (response.content) finalText = response.content;
    let stopReason: TurnStatus | null = (await checkpoint()) ? null : 'checkpoint_failed';

    if (!response.toolCalls.length) return finish(stopReason ?? 'completed');

    // A reply cut off at the output limit may hold a half-written call.
    const cutOff = response.finishReason === 'length' || response.finishReason === 'content_filter';
    for (let i = 0; i < response.toolCalls.length; i++) {
      const call = response.toolCalls[i];
      emit({ type: 'tool_call', call });
      if (!stopReason && signal?.aborted) stopReason = 'aborted';
      if (!stopReason && maxTotalTokens !== undefined && tokensUsed() >= maxTotalTokens) stopReason = 'token_budget';
      let outcome: { content: string; success: boolean; stopped?: TurnStatus };
      if (stopReason) {
        outcome = { content: `Not run: the turn stopped (${ stopReason }).`, success: false };
      } else if (cutOff) {
        outcome = {
          content: response.finishReason === 'length'
            ? 'Not run: output was cut off at the output token limit, so this call may be incomplete. Send it again with shorter arguments.'
            : 'Not run: output was cut off by the provider (content_filter).',
          success: false,
        };
      } else {
        outcome = await runOneTool(call, resolved[i], options);
      }
      if (outcome.stopped) stopReason = outcome.stopped;
      messages.push(toolMessage(call, outcome.content, !outcome.success));
      emit({ type: 'tool_result', id: call.id, name: call.name, success: outcome.success });
      if (!(await checkpoint()) && !stopReason) stopReason = 'checkpoint_failed';
    }
    if (stopReason) return finish(stopReason);
  }
}

const NOT_RUN_ABORTED = { content: 'Not run: the turn stopped (aborted).', success: false, stopped: 'aborted' as TurnStatus };

async function runOneTool(call: ToolCall, resolved: ResolvedCall, options: RunTurnOptions): Promise<{ content: string; success: boolean; stopped?: TurnStatus }> {
  if (resolved.kind === 'error') return { content: `Error: ${ resolved.message }`, success: false };

  const validation = validateParams(resolved.spec.inputSchema, resolved.args);
  if (!validation.ok) return { content: `Error: ${ validation.error }`, success: false };

  const request = { id: call.id, name: resolved.spec.name, args: validation.params };
  const ctx = { runId: options.runId, signal: options.signal };
  const toolHost = options.host.toolHost;
  // Fails closed: a missing or unknown sideEffect needs a tap too.
  if (needsApproval(resolved.spec)) {
    if (!toolHost.approve) {
      return { content: `Error: "${ resolved.spec.name }" needs the user's approval and this device can't ask for it.`, success: false };
    }
    let approved = false;
    try {
      const answer = await unlessAborted(toolHost.approve(request, resolved.spec, ctx), options.signal);
      if (answer.aborted) return NOT_RUN_ABORTED;
      approved = answer.value === true;
    } catch {
      approved = false;
    }
    if (options.signal?.aborted) return NOT_RUN_ABORTED;
    if (!approved) return { content: `Error: the user did not approve "${ resolved.spec.name }".`, success: false };
  }

  try {
    const result = await toolHost.invoke(request, ctx);
    if (result.success) return { content: formatToolResult(result.result ?? null), success: true };
    const err = result.error ?? { code: 'tool_error', message: 'Tool failed' };
    return { content: formatToolResult(redactSecrets(`Error (${ String(err.code) }): ${ String(err.message) }`)), success: false };
  } catch (err) {
    return { content: formatToolResult(`Error (tool_exception): ${ errorText(err) }`), success: false };
  }
}
