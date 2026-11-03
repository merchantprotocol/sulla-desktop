// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import {
  AuthExpired, AuthRevoked, CliExhausted, EmptyResponse, Interrupted, ProviderFailure, QuotaExceeded, RateLimited,
  RoutingUnavailable, TimedOut, Transient, Unknown, VaultLocked, legacyProviderFailure,
} from './failures';

export type LLMFailureKind =
  | 'auth'
  | 'quota'
  | 'rate_limit'
  | 'timeout'
  | 'unavailable'
  | 'empty'
  | 'interrupted'
  | 'unknown';

export interface LLMFailureRecovery {
  kind:            LLMFailureKind;
  retryPrimary:    boolean;
  fallbackAllowed: boolean;
  userMessage:     string;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-proj-[A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\b/g,
];

export function redactLLMFailureMessage(value: unknown): string {
  let text = value instanceof Error ? value.message : String(value ?? '');
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, '[redacted]');
  }
  return text;
}

export function classifyLLMFailure(error: unknown): LLMFailureRecovery {
  const name = (error as any)?.name;
  const message = redactLLMFailureMessage(error);
  const lower = `${ name || '' } ${ message }`.toLowerCase();

  // Abort messages can lose their AbortError name while crossing a process boundary.
  if (name === 'AbortError' || lower.includes('aborted') || lower.includes('aborterror')) {
    return { kind: 'interrupted', retryPrimary: false, fallbackAllowed: false, userMessage: 'The prior model run was interrupted.' };
  }
  const typed = error instanceof ProviderFailure ? error : legacyProviderFailure('The selected model provider', error);

  if (typed instanceof CliExhausted || (error as any)?.cliRecoveryExhausted) {
    const unsafe = Boolean((error as any)?.unsafeToFallback);
    return {
      kind:            'unavailable',
      retryPrimary:    false,
      fallbackAllowed: !unsafe,
      userMessage:     unsafe
        ? 'The selected CLI model stopped while a tool result was uncertain, so recovery was stopped safely.'
        : 'The selected CLI model stopped responding after its bounded recovery attempts.',
    };
  }

  if ((error as any)?.unsafeToFallback) {
    return {
      kind:            'unavailable',
      retryPrimary:    false,
      fallbackAllowed: false,
      userMessage:     'The CLI stopped while a tool result was still uncertain, so automatic recovery was stopped to avoid repeating an action.',
    };
  }

  if (typed instanceof AuthExpired || typed instanceof AuthRevoked || typed instanceof VaultLocked) {
    return {
      kind:            'auth',
      retryPrimary:    false,
      fallbackAllowed: false,
      userMessage:     typed.userMessage,
    };
  }

  if (typed instanceof QuotaExceeded) {
    return {
      kind:            'quota',
      retryPrimary:    false,
      fallbackAllowed: true,
      userMessage:     typed.userMessage,
    };
  }

  if (typed instanceof RateLimited) {
    return {
      kind:            'rate_limit',
      retryPrimary:    true,
      fallbackAllowed: true,
      userMessage:     typed.userMessage,
    };
  }

  if (typed instanceof TimedOut) {
    return { kind: 'timeout', retryPrimary: true, fallbackAllowed: true, userMessage: typed.userMessage };
  }

  if (typed instanceof EmptyResponse) {
    return { kind: 'empty', retryPrimary: true, fallbackAllowed: true, userMessage: typed.userMessage };
  }

  if (typed instanceof Interrupted) {
    return { kind: 'interrupted', retryPrimary: false, fallbackAllowed: false, userMessage: typed.userMessage };
  }

  if (typed instanceof Transient || typed instanceof RoutingUnavailable) {
    return {
      kind:            'unavailable',
      retryPrimary:    true,
      fallbackAllowed: true,
      userMessage:     typed.userMessage,
    };
  }

  return {
    kind:            'unknown',
    retryPrimary:    false,
    fallbackAllowed: true,
    userMessage:     typed instanceof Unknown ? typed.userMessage : 'The selected model provider failed.',
  };
}

export function sameLLMRoute(a: { provider: string; model: string }, b: { provider: string; model: string }): boolean {
  return a.provider.trim().toLowerCase() === b.provider.trim().toLowerCase() &&
    a.model.trim().toLowerCase() === b.model.trim().toLowerCase();
}
