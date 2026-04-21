// SecretsCapabilityService
//
// Mints short-lived, single-use-per-key capability tokens that runtime
// containers (python/shell/node) use to fetch secrets from the vault
// during a single function invocation.
//
// Security properties:
//   * Plaintext secrets live only in the process memory that calls resolve().
//   * Tokens are scope-limited (allowed envVar keys only), time-limited
//     (default 60s), and single-use per key within the capability.
//   * Capabilities are invalidated on explicit completion and are also
//     swept periodically when they expire.
//   * Nothing in this module logs secret values, refs, or tokens. Only
//     invocationId + envKey + outcome may be logged.
//
// This state is process-local and intentionally never persisted.
//
// NOTE: This is NOT an Electron IPC channel — it is an in-memory service
// consumed by the HTTP server in `main/sullaSecretsServer.ts`.
import * as crypto from 'crypto';

import { IntegrationValueModel } from '../database/models/IntegrationValueModel';

const DEFAULT_TTL_MS = 60_000;
const SWEEP_INTERVAL_MS = 30_000;
const TOKEN_BYTES = 32;

export interface SecretRef {
  integrationId: string;
  accountId:     string;
  property:      string;
}

interface Capability {
  token:        string;
  invocationId: string;
  refs:         Map<string, SecretRef>;
  consumed:     Set<string>;
  expiresAt:    number;
}

export type ResolveOutcome =
  | 'granted'
  | 'unknown-token'
  | 'expired'
  | 'key-not-allowed'
  | 'key-already-consumed'
  | 'not-found';

export class SecretsResolveError extends Error {
  constructor(public outcome: Exclude<ResolveOutcome, 'granted'>) {
    super(`secrets capability: ${ outcome }`);
    this.name = 'SecretsResolveError';
  }
}

let instance: SecretsCapabilityService | null = null;

export function getSecretsCapabilityService(): SecretsCapabilityService {
  if (!instance) {
    instance = new SecretsCapabilityService();
  }
  return instance;
}

export class SecretsCapabilityService {
  private capabilities = new Map<string, Capability>();
  private sweepTimer:    NodeJS.Timeout | null = null;

  constructor() {
    this.startSweepTimer();
  }

  /**
   * Mint a new capability token bound to a set of envVar→SecretRef mappings.
   * The returned token is 32 random bytes, base64url-encoded.
   */
  mint(params: {
    invocationId: string;
    refs:         Record<string, SecretRef>;
    ttlMs?:       number;
  }): { token: string } {
    const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
    const ttl = params.ttlMs ?? DEFAULT_TTL_MS;

    const refMap = new Map<string, SecretRef>();
    for (const [envVar, ref] of Object.entries(params.refs)) {
      refMap.set(envVar, {
        integrationId: ref.integrationId,
        accountId:     ref.accountId,
        property:      ref.property,
      });
    }

    const cap: Capability = {
      token,
      invocationId: params.invocationId,
      refs:         refMap,
      consumed:     new Set<string>(),
      expiresAt:    Date.now() + ttl,
    };

    this.capabilities.set(token, cap);
    return { token };
  }

  /**
   * Resolve a single envVar key via its token. Single-use per key.
   *
   * On success: marks the key consumed and returns the plaintext value.
   * On failure: throws `SecretsResolveError` with a discriminated outcome.
   *
   * Callers (the HTTP server) must NOT echo the envKey or the value back in
   * error responses — that is the server's responsibility.
   */
  async resolve(token: string, envKey: string): Promise<string> {
    const cap = this.capabilities.get(token);
    if (!cap) {
      this.logOutcome('?', envKey, 'unknown-token');
      throw new SecretsResolveError('unknown-token');
    }

    if (Date.now() >= cap.expiresAt) {
      this.capabilities.delete(token);
      this.logOutcome(cap.invocationId, envKey, 'expired');
      throw new SecretsResolveError('expired');
    }

    const ref = cap.refs.get(envKey);
    if (!ref) {
      this.logOutcome(cap.invocationId, envKey, 'key-not-allowed');
      throw new SecretsResolveError('key-not-allowed');
    }

    if (cap.consumed.has(envKey)) {
      this.logOutcome(cap.invocationId, envKey, 'key-already-consumed');
      throw new SecretsResolveError('key-already-consumed');
    }

    const row = await IntegrationValueModel.findByKey(
      ref.integrationId,
      ref.accountId,
      ref.property,
    );
    if (!row || row.attributes.value == null) {
      // Mark consumed even on miss to preserve single-use semantics and
      // avoid spin-probing of valid keys.
      cap.consumed.add(envKey);
      this.logOutcome(cap.invocationId, envKey, 'not-found');
      throw new SecretsResolveError('not-found');
    }

    cap.consumed.add(envKey);
    this.logOutcome(cap.invocationId, envKey, 'granted');
    return row.attributes.value as string;
  }

  /** Drop a capability. No-op if unknown. */
  invalidate(token: string): void {
    this.capabilities.delete(token);
  }

  /** Stop the periodic expiry sweep (used in tests / on shutdown). */
  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    this.capabilities.clear();
  }

  // ─── Internals ─────────────────────────────────────────────────────

  private startSweepTimer(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepExpired(), SWEEP_INTERVAL_MS);
    // Do not keep the Node event loop alive just for sweeping.
    if (typeof this.sweepTimer.unref === 'function') {
      this.sweepTimer.unref();
    }
  }

  private sweepExpired(): void {
    const now = Date.now();
    for (const [token, cap] of this.capabilities) {
      if (now >= cap.expiresAt) {
        this.capabilities.delete(token);
      }
    }
  }

  /**
   * Structured outcome log. Intentionally excludes token, refs, and values.
   * Only the invocationId, envKey name, and outcome are emitted.
   */
  private logOutcome(invocationId: string, envKey: string, outcome: ResolveOutcome): void {
    console.log(
      `[SecretsCapability] invocation=${ invocationId } key=${ envKey } outcome=${ outcome }`,
    );
  }
}
