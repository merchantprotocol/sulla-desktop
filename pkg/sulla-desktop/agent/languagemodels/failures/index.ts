// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface ProviderFailureOptions {
  status?:   number;
  exitCode?: number | null;
  cause?:    unknown;
}

export abstract class ProviderFailure extends Error {
  abstract readonly retryable: boolean;

  protected constructor(
    readonly providerId: string,
    readonly userMessage: string,
    readonly status?: number,
    readonly exitCode?: number | null,
    cause?: unknown,
  ) {
    super(userMessage, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
  }
}

type FailureConstructor = new (providerId: string, options?: ProviderFailureOptions) => ProviderFailure;

function values(options?: ProviderFailureOptions): [number | undefined, number | null | undefined, unknown] {
  return [options?.status, options?.exitCode, options?.cause];
}

export class AuthExpired extends ProviderFailure {
  readonly retryable = false;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } sign-in expired. Reconnect in Settings.`, ...values(options));
  }
}

export class AuthRevoked extends ProviderFailure {
  readonly retryable = false;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } access was revoked. Reconnect in Settings.`, ...values(options));
  }
}

export class QuotaExceeded extends ProviderFailure {
  readonly retryable = false;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } has no usable quota. Check your plan or billing.`, ...values(options));
  }
}

export class RateLimited extends ProviderFailure {
  readonly retryable = true;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } is rate limited. Wait a moment and try again.`, ...values(options));
  }
}

export class Transient extends ProviderFailure {
  readonly retryable = true;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } is temporarily unavailable. Try again.`, ...values(options));
  }
}

export class TimedOut extends ProviderFailure {
  readonly retryable = true;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } timed out. Try again.`, ...values(options));
  }
}

export class EmptyResponse extends ProviderFailure {
  readonly retryable = true;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } returned no usable response. Try again.`, ...values(options));
  }
}

export class Interrupted extends ProviderFailure {
  readonly retryable = false;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, 'The prior model run was interrupted.', ...values(options));
  }
}

export class RoutingUnavailable extends ProviderFailure {
  readonly retryable = true;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } could not find an available workspace route. Try again.`, ...values(options));
  }
}

export class CliExhausted extends ProviderFailure {
  readonly retryable = false;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } stopped after its recovery attempts. Start the request again.`, ...values(options));
  }
}

export class VaultLocked extends ProviderFailure {
  readonly retryable = false;
  readonly code = 'vault_locked';
  constructor(providerId = 'vault', options: ProviderFailureOptions = { status: 423 }) {
    super(providerId, 'Your secure account is unavailable. Sign out and sign in again.', options.status ?? 423, options.exitCode, options.cause);
  }
}

export class Unknown extends ProviderFailure {
  readonly retryable = false;
  constructor(providerId: string, options?: ProviderFailureOptions) {
    super(providerId, `${ providerLabel(providerId) } failed. Try again or choose another provider.`, ...values(options));
  }
}

export function providerFailureFromHttp(providerId: string, status: number, cause?: unknown): ProviderFailure {
  const options = { status, cause };
  if (status === 401) return new AuthExpired(providerId, options);
  if (status === 403) return new AuthRevoked(providerId, options);
  if (status === 402) return new QuotaExceeded(providerId, options);
  if (status === 423) return new VaultLocked(providerId, options);
  if (status === 429) return new RateLimited(providerId, options);
  if (status >= 500) return new Transient(providerId, options);
  return new Unknown(providerId, options);
}

/** The sole compatibility classifier for boundaries that cannot expose structured status yet. */
export function legacyProviderFailure(providerId: string, value: unknown, options?: ProviderFailureOptions): ProviderFailure {
  const message = (value instanceof Error ? value.message : String(value ?? '')).toLowerCase();
  const make = (Failure: FailureConstructor) => new Failure(providerId, { ...options, cause: options?.cause ?? value });
  const coded = value as { code?: unknown; status?: unknown } | null;
  if (coded && typeof coded === 'object' && (coded.code === 'vault_locked' || coded.status === 423)) return new VaultLocked('vault', { status: 423, cause: value });
  if (/timeout|timed out|etimedout|stalled/.test(message)) return make(TimedOut);
  if (/no response|empty response|returned empty|no extractable prompt/.test(message)) return make(EmptyResponse);
  if (message.includes('workspace routing discovery failed')) return make(RoutingUnavailable);
  // Generic forbidden/access-denied transport text is not proof that credentials were revoked.
  if (/(?:oauth|credential|token|access) (?:was |has been )?revoked|revoked (?:oauth|credential|token|access)/.test(message)) return make(AuthRevoked);
  if (/unauthorized|invalid api key|expired token|not logged in|sign.?in required|\b401\b/.test(message)) return make(AuthExpired);
  if (/quota|usage balance|weekly limit|session limit|balance exhausted/.test(message)) return make(QuotaExceeded);
  if (/rate limit|too many requests/.test(message)) return make(RateLimited);
  if (/event stream|dropped event|stream lag|exited with code null|econnreset|econnrefused|network|service unavailable|\b5\d\d\b/.test(message)) return make(Transient);
  return make(Unknown);
}

function providerLabel(providerId: string): string {
  const normalized = providerId.trim().toLowerCase();
  if (normalized.includes('claude') || normalized === 'anthropic') return 'Claude';
  if (normalized.includes('codex') || normalized === 'openai' || normalized === 'chatgpt') return normalized.includes('codex') ? 'Codex' : 'OpenAI';
  if (normalized === 'vault') return 'Your secure account';
  return providerId.trim() || 'The selected provider';
}
