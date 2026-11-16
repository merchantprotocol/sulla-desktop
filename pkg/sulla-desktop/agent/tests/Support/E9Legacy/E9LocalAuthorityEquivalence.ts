// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
//
// E9 equivalence harness: runs one scripted scenario against the frozen legacy copy of
// LocalVaultAuthority (E9Legacy/localAuthority.legacy.ts) and against the current class, each
// on its own freshly migrated database, with deterministic randomness, a fixed clock and an
// offline upstream. The two transcripts (step results, errors, database rows, upstream
// requests, relay opens) must be identical. Delete in final cleanup.
//
// The spec file must vi.mock node:crypto, node:dns and node:https with E9TestDoubles first.

import { createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NobleCryptoPrimitives } from '@sulla/domain';
import { vi } from 'vitest';

import { loadSodium } from '../../../../../../services/sulla-vault/src/browserEnvelope/envelope';
import { SodiumCryptoPrimitives } from '../../../../../../services/sulla-vault/src/browserEnvelope/SodiumCryptoPrimitives';
import {
  bootstrapChallengeProofInput, bootstrapSessionKeyInput, bootstrapUnlockProofInput,
  cacheUpdateChallengeProofInput, cacheUpdateFetchProofInput, cacheUpdateSessionKeyInput,
} from '../../../../../../services/sulla-vault/src/contracts';
import type { BrokerRelaySendRequest } from '../../../../../../services/sulla-vault/src/contracts';
import type { LocalVaultAuthority } from '../../../../../../services/sulla-vault/src/localAuthority';
import { LocalVaultCrypto } from '../../../../../../services/sulla-vault/src/localCrypto/LocalVaultCrypto';
import { LocalVaultCryptoProvider } from '../../../../../../services/sulla-vault/src/localCrypto/LocalVaultCryptoProvider';
import type { VaultRelayEvent, VaultRelayHandle, VaultRelayManager, VaultRelayOpenRequest } from '../../../../../../services/sulla-vault/src/relays';
import { LegacyVaultDatabase } from '../LegacyVaultHarness';
import { E9Clock, E9CounterRandom, E9FakeUpstream, E9NodeDeterminism } from './E9TestDoubles';

export const E9_USER_ID = 'e9a00000-0000-4000-8000-000000000001';

export const E9_TOKENS = {
  bootstrap: 'b'.repeat(40),
  control:   'c'.repeat(40),
  approval:  'a'.repeat(40),
  broker:    'r'.repeat(40),
  files:     'f'.repeat(40),
} as const;

export type E9AuthorityConstructor = new (...args: any[]) => LocalVaultAuthority;

/** Relay manager double: records opens/sends/closes, never touches the network. */
export class E9RelayManagerDouble implements VaultRelayManager {
  readonly log: unknown[] = [];

  async open(request: VaultRelayOpenRequest): Promise<VaultRelayHandle> {
    this.log.push({ open: { relayId: request.relayId, operation: request.operation, credential: request.credential, gatewayUrl: request.gatewayUrl, gatewayAddress: request.gatewayAddress, targetUrl: (request as { targetUrl?: string }).targetUrl } });
    return { relayId: request.relayId, expiresAt: E9Clock.START + 60_000 };
  }

  async *events(): AsyncIterable<VaultRelayEvent> { /* no events */ }

  async send(relayId: string, command: BrokerRelaySendRequest): Promise<void> { this.log.push({ send: { relayId, command } }) }

  close(relayId: string, reason?: string): void { this.log.push({ close: { relayId, reason } }) }

  closeAll(reason?: string): void { this.log.push({ closeAll: reason }) }
}

/** Streaming sink double for executeStream. */
export class E9StreamSink {
  readonly events: unknown[] = [];
  private abort: (() => void) | undefined;

  start(status: number, headers: Record<string, string>): void { this.events.push({ start: { status, headers } }) }
  write(chunk: Buffer): boolean { this.events.push({ write: chunk.toString('utf8') }); return true }
  onceDrain(callback: () => void): void { callback() }
  end(): void { this.events.push('end') }
  destroy(error: Error): void { this.events.push({ destroy: E9Normalizer.error(error) }) }
  onAbort(callback: () => void): void { this.abort = callback }
  triggerAbort(): void { this.abort?.() }
}

/** Client side of the bootstrap / cache-update protocol (what the OS helper does). */
export class E9BootstrapClient {
  constructor(private readonly token: string, readonly callerId = 'bootstrap') {}

  proof(input: string): string { return createHmac('sha256', this.token).update(input).digest('base64url') }

  async unlock(authority: LocalVaultAuthority, masterKey: Buffer, clientNonce: string, legacyVmk?: Buffer): Promise<unknown> {
    const challenge = authority.createChallenge(this.callerId, clientNonce, this.proof(bootstrapChallengeProofInput(this.callerId, clientNonce)));
    const sessionKey = createHmac('sha256', this.token)
      .update(bootstrapSessionKeyInput(this.callerId, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt)).digest();
    const nonce = Buffer.alloc(12, 7);
    const cipher = createCipheriv('aes-256-gcm', sessionKey, nonce);
    const clear = JSON.stringify({ masterKey: masterKey.toString('base64url'), ...(legacyVmk ? { legacyVmk: legacyVmk.toString('base64url') } : {}) });
    const ciphertext = Buffer.concat([cipher.update(clear), cipher.final()]);
    const sealedUnlock = Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64url');
    const digest = createHash('sha256').update(sealedUnlock).digest('base64url');
    const result = await authority.unlock({
      callerId: this.callerId, challengeId: challenge.challengeId, sealedUnlock,
      clientProof: this.proof(bootstrapUnlockProofInput(this.callerId, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt, digest)),
    });
    return { challenge, result };
  }

  /** Fetches the staged cache update and opens it the way the helper does. */
  fetchCacheUpdate(authority: LocalVaultAuthority, clientNonce: string, sealedLegacyVmk?: string): unknown {
    const challenge = authority.createCacheUpdateChallenge(this.callerId, clientNonce, this.proof(cacheUpdateChallengeProofInput(this.callerId, clientNonce)));
    const legacyDigest = sealedLegacyVmk ? createHash('sha256').update(sealedLegacyVmk).digest('base64url') : '-';
    const fetched = authority.fetchCacheUpdate({
      callerId: this.callerId, challengeId: challenge.challengeId, sealedLegacyVmk,
      clientProof: this.proof(cacheUpdateFetchProofInput(this.callerId, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt, legacyDigest)),
    });
    const sessionKey = createHmac('sha256', this.token)
      .update(cacheUpdateSessionKeyInput(this.callerId, clientNonce, challenge.serverNonce, challenge.challengeId, challenge.expiresAt)).digest();
    const packed = Buffer.from(fetched.sealedMaster, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', sessionKey, packed.subarray(0, 12));
    decipher.setAuthTag(packed.subarray(12, 28));
    const opened = JSON.parse(Buffer.concat([decipher.update(packed.subarray(28)), decipher.final()]).toString('utf8')) as { masterKey: string };
    return { challenge, fetched, opened };
  }
}

/** Makes step results comparable: dates/timestamps masked, bytes as hex, errors by name/code/status/message/reason. */
export class E9Normalizer {
  private static readonly TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;

  static value(input: unknown): unknown {
    if (input === undefined) return '<undefined>';
    if (input === null) return null;
    if (input instanceof Date) return '<date>';
    if (Buffer.isBuffer(input) || input instanceof Uint8Array) return `bytes:${ Buffer.from(input).toString('hex') }`;
    if (typeof input === 'string') return E9Normalizer.text(input);
    if (typeof input === 'bigint') return `bigint:${ input }`;
    if (typeof input === 'function') return '<function>';
    if (input instanceof Error) return E9Normalizer.error(input);
    if (Array.isArray(input)) return input.map(entry => E9Normalizer.value(entry));
    if (typeof input === 'object') {
      const output: Record<string, unknown> = {};
      for (const key of Object.keys(input as Record<string, unknown>).sort()) output[key] = E9Normalizer.value((input as Record<string, unknown>)[key]);
      return output;
    }
    return input;
  }

  static text(input: string): string { return input.replace(E9Normalizer.TIMESTAMP, '<ts>') }

  static error(error: unknown): Record<string, unknown> {
    if (!(error instanceof Error)) return { thrown: E9Normalizer.value(error) };
    const shaped = error as Error & { code?: unknown; status?: unknown; statusCode?: unknown; reason?: unknown };
    return {
      name: error.constructor?.name ?? error.name, code: E9Normalizer.value(shaped.code ?? null), status: E9Normalizer.value(shaped.status ?? null),
      statusCode: E9Normalizer.value(shaped.statusCode ?? null), message: E9Normalizer.text(error.message), reason: E9Normalizer.value(shaped.reason ?? null),
    };
  }
}

/** Everything a scenario step can touch. */
export class E9Context {
  readonly memory = new Map<string, unknown>();
  readonly bootstrap = new E9BootstrapClient(E9_TOKENS.bootstrap);
  session: { sessionId: string; csrf: string } | null = null;

  constructor(
    readonly authority: LocalVaultAuthority,
    readonly database: LegacyVaultDatabase,
    readonly relays: E9RelayManagerDouble,
    readonly upstream: E9FakeUpstream,
    readonly clock: E9Clock,
  ) {}

  get sessionId(): string | undefined { return this.session?.sessionId }
  get csrf(): string | undefined { return this.session?.csrf }

  /** Remembers the newest human session grant returned by a step. */
  remember<T>(value: T): T {
    const grant = value as { sessionId?: unknown; csrf?: unknown };
    if (typeof grant?.sessionId === 'string' && typeof grant.csrf === 'string') this.session = { sessionId: grant.sessionId, csrf: grant.csrf };
    return value;
  }

  claims(extra: Record<string, unknown> = {}): Record<string, unknown> {
    return { sub: E9_USER_ID, agent_id: 'research-agent', pod_id: 'pod-1', ...extra };
  }

  async itemIdFor(integrationRef: string): Promise<string> {
    const result = await this.database.db.query<{ id: string }>('SELECT id FROM items WHERE integration_ref=$1 AND deleted_at IS NULL ORDER BY id LIMIT 1', [integrationRef]);
    return result.rows[0]?.id ?? 'missing';
  }
}

export interface E9Step {
  name: string;
  run(context: E9Context): unknown;
}

export interface E9Transcript {
  steps:    unknown[];
  tables:   Record<string, string[]>;
  upstream: unknown[];
  relays:   unknown[];
}

/** Runs one scripted scenario on a fresh database and records everything observable. */
export class E9ScenarioRunner {
  static readonly TABLES = [
    'users', 'items', 'audit_log', 'local_vault_recovery', 'local_vault_recovery_history', 'local_vault_wrap_history',
    'local_integration_state', 'sulla_cloud_pending_revocations', 'local_vault_migration_batches',
  ];

  constructor(private readonly config: Record<string, unknown> = {}) {}

  async run(constructor: E9AuthorityConstructor, steps: E9Step[], prepare?: (database: LegacyVaultDatabase) => Promise<void>): Promise<E9Transcript> {
    const database = await new LegacyVaultDatabase().open();
    await database.db.query(`ALTER TABLE users ALTER COLUMN id SET DEFAULT '${ E9_USER_ID }'::uuid`);
    if (prepare) await prepare(database);
    const determinism = E9NodeDeterminism.shared();
    const upstream = E9FakeUpstream.shared();
    const clock = new E9Clock();
    const relays = new E9RelayManagerDouble();
    const sodium = await loadSodium();
    const provider = new LocalVaultCryptoProvider(LocalVaultCrypto.compose(new SodiumCryptoPrimitives(sodium, new NobleCryptoPrimitives()), new E9CounterRandom()));
    upstream.reset();
    determinism.reset();
    determinism.enabled = true;
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock.now);
    const transcript: E9Transcript = { steps: [], tables: {}, upstream: [], relays: [] };
    try {
      const authority = new constructor(database.db, this.vaultConfig(), relays,
        undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, provider);
      const context = new E9Context(authority, database, relays, upstream, clock);
      for (const step of steps) {
        try {
          transcript.steps.push({ step: step.name, ok: true, value: E9Normalizer.value(await step.run(context)) });
        } catch (error) {
          transcript.steps.push({ step: step.name, ok: false, error: E9Normalizer.error(error) });
        }
      }
      for (const table of E9ScenarioRunner.TABLES) {
        const strip = table === 'users' || table === 'items' ? '' : " - 'id'";
        const rows = await database.db.query<{ row: string }>(`SELECT (to_jsonb(t)${ strip })::text AS row FROM ${ table } t`);
        transcript.tables[table] = rows.rows.map(row => E9Normalizer.text(row.row)).sort();
      }
      transcript.upstream = E9Normalizer.value(upstream.requests) as unknown[];
      transcript.relays = E9Normalizer.value(relays.log) as unknown[];
      await authority.lock().catch(() => undefined);
      return transcript;
    } finally {
      now.mockRestore();
      determinism.enabled = false;
      await database.close();
    }
  }

  private vaultConfig(): Record<string, unknown> {
    return {
      mode: 'desktop', port: 0, databaseUrl: 'postgresql://synthetic/unused', extensionOrigins: [],
      auditSpoolDir: mkdtempSync(join(tmpdir(), 'e9-local-authority-')),
      bootstrapServiceId: 'bootstrap', bootstrapServiceToken: E9_TOKENS.bootstrap,
      controlServiceId: 'control', controlServiceToken: E9_TOKENS.control,
      approvalServiceId: 'approval', approvalServiceToken: E9_TOKENS.approval,
      brokerServiceId: 'broker', brokerServiceToken: E9_TOKENS.broker,
      filesServiceId: 'files', filesServiceToken: E9_TOKENS.files,
      ...this.config,
    };
  }
}
