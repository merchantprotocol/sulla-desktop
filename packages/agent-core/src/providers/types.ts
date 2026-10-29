// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createSseParser } from './sse.js';

import type { AbortSignalLike, HttpRequest, HttpResponseLike, StreamResponseHead, StreamTransport, Transport } from '../host.js';
import type { ChatMessage, NormalizedResponse, ToolSpec } from '../types.js';
import type { SseEvent } from './sse.js';

export type ProviderApi = 'anthropic-messages' | 'openai-chat';

export interface ProviderCallInput {
  model:            string;
  system?:          string;
  messages:         ChatMessage[];
  tools:            ToolSpec[];
  maxOutputTokens?: number;
  temperature?:     number;
}

/**
 * Maps the portable transcript to one provider wire format and back.
 * `buildRequest` and `parseResponse` are pure; `complete` and `stream` send
 * through the injected transport (the host's KeyBroker), so no adapter ever
 * holds a credential.
 *
 * `toolCalls` and the `tool_use` entries in `blocks` are in the same order,
 * one for one; runTurn relies on that when it makes ids unique.
 */
export interface ProviderAdapter {
  readonly api: ProviderApi;
  buildRequest(input: ProviderCallInput, options?: { stream?: boolean }): HttpRequest;
  parseResponse(body: unknown): NormalizedResponse;
  complete(input: ProviderCallInput, transport: Transport, signal?: AbortSignalLike): Promise<NormalizedResponse>;
  /**
   * Streams the reply, calling `onText` with each text delta, and resolves
   * to the same NormalizedResponse `complete` would return.
   */
  stream(input: ProviderCallInput, transport: StreamTransport, onText: (text: string) => void, signal?: AbortSignalLike): Promise<NormalizedResponse>;
}

/**
 * A provider call failed. `message` is safe to show: key-like strings are
 * redacted. A plain Error with fields, not a subclass: the Hermes CLI
 * can't parse `class` syntax without a Babel pass.
 */
export interface ProviderError extends Error {
  readonly isProviderError: true;
  readonly status:          number;
  readonly retryable:       boolean;
  readonly code:            string;
}

export function providerError(message: string, status: number, code: string): ProviderError {
  const err = new Error(message) as Error & Record<string, unknown>;
  err.name = 'ProviderError';
  err.isProviderError = true;
  err.status = status;
  err.code = code;
  err.retryable = status === 408 || status === 429 || status >= 500;
  return err as unknown as ProviderError;
}

export function isProviderError(err: unknown): err is ProviderError {
  return !!err && typeof err === 'object' && (err as { isProviderError?: unknown }).isProviderError === true;
}

const KEY_LIKE = /\b(sk|xai|gsk|pk|rk|key)[-_][A-Za-z0-9_*-]{6,}(?:\.[A-Za-z0-9_*-]+)*/gi;

/** Strip anything that looks like an API key from provider error text. */
export function redactSecrets(text: string): string {
  return text.replace(KEY_LIKE, '[redacted]').replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]');
}

function errorCode(status: number): string {
  if (status < 400) return 'provider_error';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit_exhausted';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'bad_request';
}

/** Best human-readable message in a provider error body. */
function errorDetail(parsed: any, fallback: string): string {
  const e = parsed?.error;
  if (typeof e === 'string') return e;
  return String(e?.message ?? parsed?.message ?? fallback);
}

/**
 * Status for an error reported inside a body. OpenRouter puts the HTTP
 * status in `error.code`; Anthropic stream errors carry only a type.
 */
const ERROR_TYPE_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error:  401,
  billing_error:         402,
  permission_error:      403,
  not_found_error:       404,
  request_too_large:     413,
  rate_limit_error:      429,
  api_error:             500,
  overloaded_error:      529,
};

function bodyErrorStatus(error: any, fallback: number): number {
  if (typeof error?.code === 'number' && error.code >= 400) return error.code;
  if (typeof error?.status === 'number' && error.status >= 400) return error.status;
  const byType = typeof error?.type === 'string' ? ERROR_TYPE_STATUS[error.type] : undefined;
  return byType ?? fallback;
}

/** A ProviderError for an error object found in a response body (any status). */
export function bodyError(parsed: any, status: number): ProviderError {
  const s = bodyErrorStatus(parsed?.error, status);
  const message = redactSecrets(`Provider returned ${ s }: ${ errorDetail(parsed, 'unknown error').slice(0, 500) }`);
  return providerError(message, s, errorCode(s));
}

function httpError(status: number, text: string): ProviderError {
  let detail = text;
  try {
    detail = errorDetail(JSON.parse(text), text);
  } catch { /* not JSON */ }
  const message = redactSecrets(`Provider returned ${ status }: ${ String(detail).slice(0, 500) }`);
  return providerError(message, status, errorCode(status));
}

function networkError(err: unknown, signal?: AbortSignalLike): ProviderError {
  if (signal?.aborted) return providerError('Request aborted', 0, 'aborted');
  return providerError(redactSecrets(`Network error: ${ (err as Error)?.message ?? String(err) }`), 0, 'network');
}

/**
 * Send a request and parse JSON, turning HTTP failures into ProviderError.
 * A 2xx body with a top-level `error` (OpenRouter does this) is a failure
 * too, not an empty reply.
 */
export async function sendJson(request: HttpRequest, transport: Transport, signal?: AbortSignalLike): Promise<unknown> {
  let response: HttpResponseLike;
  let text: string;
  try {
    response = await transport(request, signal);
    text = await response.text();
  } catch (err) {
    throw networkError(err, signal);
  }
  if (!response.ok) throw httpError(response.status, text);
  let parsed: any;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw providerError('Provider returned a response that is not JSON', response.status, 'bad_response');
  }
  if (parsed && typeof parsed === 'object' && parsed.error) throw bodyError(parsed, response.status);
  return parsed;
}

/**
 * Send a streaming request and feed each SSE event to `onEvent`. HTTP
 * failures become ProviderError from the collected error body.
 */
export async function sendStream(request: HttpRequest, transport: StreamTransport, onEvent: (event: SseEvent) => void, signal?: AbortSignalLike): Promise<void> {
  let raw = '';
  let failed: unknown;
  const parser = createSseParser(ev => {
    if (failed === undefined) {
      try {
        onEvent(ev);
      } catch (err) {
        failed = err;
      }
    }
  });
  let head: StreamResponseHead;
  try {
    head = await transport(request, chunk => {
      if (raw.length < 8192) raw += chunk;
      parser.push(chunk);
    }, signal);
  } catch (err) {
    throw networkError(err, signal);
  }
  if (!head.ok) throw httpError(head.status, raw);
  parser.end();
  if (failed !== undefined) throw failed;
}

/** Parse one SSE data payload; null for `[DONE]` or non-JSON keep-alives. */
export function parseSseJson(data: string): any {
  const t = data.trim();
  if (!t || t === '[DONE]') return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}
