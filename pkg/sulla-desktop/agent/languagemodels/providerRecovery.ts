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
  | 'infrastructure'
  | 'unknown';

export interface LLMFailureRecovery {
  kind:            LLMFailureKind;
  retryPrimary:    boolean;
  fallbackAllowed: boolean;
  userMessage:     string;
}

/** A local Sulla runtime/setup failure. It is never evidence that a model provider is unhealthy. */
export class InfrastructureFailure extends Error {
  readonly code = 'SULLA_INFRA';
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InfrastructureFailure';
  }
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

/**
 * The Sulla provider bridge (vault broker in front of Codex/Claude CLIs)
 * failed, not the provider. Its error bodies always say "provider bridge" and
 * carry a `provider_bridge_*` type; the CLI echoes that text, and Sulla's CLI
 * recovery wraps it in a cause chain, so walk the chain.
 */
export function isProviderBridgeFailure(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 8; depth++) {
    const text = `${ current?.code ?? '' } ${ current?.message ?? (typeof current === 'string' ? current : '') }`.toLowerCase();
    if (text.includes('provider bridge') || text.includes('provider_bridge_')) return true;
    current = current?.cause;
  }
  return false;
}

/**
 * The provider bridge refused the request outright (revoked lifecycle,
 * identity change, model outside the lease, bad capability). Unlike a 503
 * "temporarily unavailable" bridge failure this is permanent for the lease, so
 * re-running the same CLI process can only fail the same way.
 */
export function isProviderBridgeDenial(error: unknown): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 8; depth++) {
    if (current.providerBridgeRevoked === true) return true;
    const text = String(current?.message ?? (typeof current === 'string' ? current : '')).toLowerCase();
    if (text.includes('provider bridge request denied')) return true;
    current = current?.cause;
  }
  return false;
}

/** A bridge denial surfaced as one Sulla-side failure instead of a retried CLI fault. */
export class ProviderBridgeDeniedFailure extends InfrastructureFailure {
  readonly providerBridgeDenied = true;

  constructor(cause: unknown) {
    super(`Sulla's provider bridge refused this model request: ${ redactLLMFailureMessage(cause) }`, cause);
    this.name = 'ProviderBridgeDeniedFailure';
  }
}

export function classifyLLMFailure(error: unknown): LLMFailureRecovery {
  const name = (error as any)?.name;
  const message = redactLLMFailureMessage(error);
  const lower = `${ name || '' } ${ message }`.toLowerCase();

  // Failures in Sulla's runtime/container plumbing are not provider failures and must never affect routing health.
  const infrastructure = error instanceof InfrastructureFailure || (error as any)?.code === 'SULLA_INFRA' ||
    lower.includes('sulla-runtime exec') ||
    lower.includes('/dev/shm/sulla-agent-secrets/') ||
    lower.includes('container lifecycle') ||
    lower.includes('spawn error') || lower.includes('spawn failed') ||
    (lower.includes('enoent') && (lower.includes('/dev/shm/') || lower.includes('/mnt/') || lower.includes('sulla'))) ||
    lower.includes('getservicebyprovider');
  if (infrastructure) {
    return { kind: 'infrastructure', retryPrimary: false, fallbackAllowed: false, userMessage: 'Sulla could not start the model runtime.' };
  }
  // Every CLI provider shares the bridge, so a bridge outage is Sulla's, never the provider's (Jonathon's routing rule).
  if (isProviderBridgeFailure(error)) {
    return {
      kind:            'infrastructure',
      retryPrimary:    false,
      fallbackAllowed: false,
      userMessage:     'Sulla\'s secure connection to the model provider is temporarily unavailable. Try again in a moment.',
    };
  }

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
    retryPrimary:    true,
    fallbackAllowed: true,
    userMessage:     typed instanceof Unknown ? typed.userMessage : 'The selected model provider failed.',
  };
}

export function sameLLMRoute(a: { provider: string; model: string }, b: { provider: string; model: string }): boolean {
  return a.provider.trim().toLowerCase() === b.provider.trim().toLowerCase() &&
    a.model.trim().toLowerCase() === b.model.trim().toLowerCase();
}
