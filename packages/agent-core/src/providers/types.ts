// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AbortSignalLike, HttpRequest, HttpResponseLike, Transport } from '../host.js';
import type { ChatMessage, NormalizedResponse, ToolSpec } from '../types.js';

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
 * `buildRequest` and `parseResponse` are pure; `complete` sends through
 * the injected transport (the host's KeyBroker), so no adapter ever holds
 * a credential.
 */
export interface ProviderAdapter {
  readonly api: ProviderApi;
  buildRequest(input: ProviderCallInput): HttpRequest;
  parseResponse(body: unknown): NormalizedResponse;
  complete(input: ProviderCallInput, transport: Transport, signal?: AbortSignalLike): Promise<NormalizedResponse>;
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
  err.retryable = status === 429 || status >= 500;
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
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit_exhausted';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'provider_unavailable';
  return 'bad_request';
}

/** Send a request and parse JSON, turning HTTP failures into ProviderError. */
export async function sendJson(request: HttpRequest, transport: Transport, signal?: AbortSignalLike): Promise<unknown> {
  let response: HttpResponseLike;
  try {
    response = await transport(request, signal);
  } catch (err) {
    if (signal?.aborted) throw providerError('Request aborted', 0, 'aborted');
    throw providerError(redactSecrets(`Network error: ${ (err as Error)?.message ?? String(err) }`), 0, 'network');
  }
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      detail = parsed?.error?.message ?? parsed?.message ?? text;
    } catch { /* not JSON */ }
    const message = redactSecrets(`Provider returned ${ response.status }: ${ String(detail).slice(0, 500) }`);
    throw providerError(message, response.status, errorCode(response.status));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw providerError('Provider returned a response that is not JSON', response.status, 'bad_response');
  }
}
