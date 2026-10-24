// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// The server-providers system collection: model provider API keys for the
// organization's server agents (Anthropic, OpenAI, ...).
//
// A provider key has to be usable by the Agents service, so it can't be
// end-to-end encrypted to people. It is sealed instead (X25519 sealed box) to
// the Agents broker's public key before it reaches Vault, so Vault stores and
// returns only ciphertext and can't open it; only the Agents container, which
// holds the private key, can. The console seals it; Vault checks the envelope
// shape and that it was sealed to the current recipient key.
//
//   GET    /v1/server-providers/recipient     org owner/admin: the public key to seal to
//   GET    /v1/server-providers               org owner/admin: which providers have a key (no ciphertext)
//   PUT    /v1/server-providers/:provider     org owner/admin: store a sealed key
//   DELETE /v1/server-providers/:provider     org owner/admin: remove it
//   POST   /v1/broker/server-providers/credential   Agents service identity: the sealed key for one org + provider
//
// Every write and every broker read lands in the append-only audit_log.

import { timingSafeEqual } from 'node:crypto';

import { publicKeyFingerprint } from '@sulla/vault-crypto';
import express, { type NextFunction, type Request, type Response } from 'express';

import { authenticate, type AuthenticatedRequest } from '../auth.js';
import { findMember, type Member } from './store.js';

import type { BrowserSyncConfig } from './config.js';
import type { VaultConfig } from '../config.js';
import type { Database } from '../db.js';

const PROVIDER = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;
const B64 = /^[A-Za-z0-9_-]+$/;
// A sealed box adds 48 bytes; provider keys are well under 4 KB.
const MIN_SEALED_CHARS = 66;
const MAX_SEALED_CHARS = 8192;

class ProviderError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

interface SealedCredential { version: 1; algorithm: 'x25519-sealed-box'; ciphertext: string }

function sealedCredential(value: unknown): SealedCredential {
  const envelope = value as Record<string, unknown> | null;
  const valid = Boolean(envelope)
    && typeof envelope === 'object'
    && Object.keys(envelope!).length === 3
    && envelope!.version === 1
    && envelope!.algorithm === 'x25519-sealed-box'
    && typeof envelope!.ciphertext === 'string'
    && envelope!.ciphertext.length >= MIN_SEALED_CHARS
    && envelope!.ciphertext.length <= MAX_SEALED_CHARS
    && B64.test(envelope!.ciphertext);
  if (!valid) throw new ProviderError(422, 'sealed_credential_invalid');
  return { version: 1, algorithm: 'x25519-sealed-box', ciphertext: envelope!.ciphertext as string };
}

function provider(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER.test(value)) throw new ProviderError(400, 'provider_invalid');
  return value;
}

function safeTokenEqual(actual: string | undefined, expected: string | undefined): boolean {
  if (!actual || !expected) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function route(handler: (request: AuthenticatedRequest, response: Response) => Promise<unknown>) {
  return (request: Request, response: Response, next: NextFunction): void => {
    handler(request as AuthenticatedRequest, response).catch(next);
  };
}

export function createServerProvidersRouter(
  db: Database,
  config: VaultConfig,
  sync: BrowserSyncConfig,
): express.Router {
  const router = express.Router();
  const authenticated = authenticate(config, db);

  /** The caller's org, from their Accounts token or an explicit header, and only for an owner or admin. */
  async function manager(request: AuthenticatedRequest): Promise<Member> {
    const fromAccounts = request.auth?.source === 'accounts' ? request.auth.organizationId : undefined;
    const orgId = fromAccounts ?? request.header('x-sulla-organization-id');
    if (!orgId || !UUID.test(orgId)) throw new ProviderError(400, 'organization_required');
    const found = await findMember(db, request.auth!.userId, orgId);
    if (!found || (found.role !== 'owner' && found.role !== 'admin')) {
      throw new ProviderError(403, 'organization_admin_required');
    }
    return found;
  }

  async function recipient(): Promise<{ publicKey: string; fingerprint: string }> {
    if (!sync.providersRecipientKey) throw new ProviderError(503, 'recipient_not_configured');
    const fingerprint = await publicKeyFingerprint(sync.providersRecipientKey);
    return { publicKey: sync.providersRecipientKey, fingerprint };
  }

  async function audit(
    userId: string,
    orgId: string,
    action: string,
    metadata: Record<string, string>,
    blocked = false,
    podId: string | null = null,
  ): Promise<void> {
    await db.query(
      `INSERT INTO audit_log(actor_user_id, org_id, action, pod_id, metadata, blocked, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, orgId, action, podId, metadata, blocked, blocked ? 'Provider credential unavailable' : null],
    );
  }

  router.get('/server-providers/recipient', authenticated, route(async(request, response) => {
    await manager(request);
    response.json(await recipient());
  }));

  router.get('/server-providers', authenticated, route(async(request, response) => {
    const caller = await manager(request);
    const rows = await db.query<{
      provider:              string;
      revision:              string;
      recipient_fingerprint: string;
      updated_at:            Date;
    }>(
      `SELECT provider, revision::text, recipient_fingerprint, updated_at
         FROM server_provider_credentials WHERE org_id = $1 ORDER BY provider`,
      [caller.orgId],
    );
    const current = sync.providersRecipientKey ? (await recipient()).fingerprint : null;
    response.json({
      providers: rows.rows.map(row => ({
        provider:  row.provider,
        revision:  Number(row.revision),
        // A key sealed to a retired recipient key can't be opened by Agents any more; it must be entered again.
        usable:    row.recipient_fingerprint === current,
        updatedAt: row.updated_at.toISOString(),
      })),
    });
  }));

  router.put('/server-providers/:provider', authenticated, route(async(request, response) => {
    const caller = await manager(request);
    const name = provider(request.params.provider);
    const sealed = sealedCredential(request.body?.sealedCredential);
    const { fingerprint } = await recipient();
    if (request.body?.recipientFingerprint !== fingerprint) throw new ProviderError(409, 'recipient_changed');
    const saved = await db.query<{ revision: string }>(
      `INSERT INTO server_provider_credentials(org_id, provider, sealed_credential, recipient_fingerprint, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (org_id, provider) DO UPDATE SET
         sealed_credential = excluded.sealed_credential, recipient_fingerprint = excluded.recipient_fingerprint,
         updated_by = excluded.updated_by, revision = server_provider_credentials.revision + 1, updated_at = now()
       RETURNING revision::text`,
      [caller.orgId, name, sealed, fingerprint, caller.userId],
    );
    await audit(caller.userId, caller.orgId, 'server_provider_credential_set', { provider: name });
    response.json({ provider: name, revision: Number(saved.rows[0].revision) });
  }));

  router.delete('/server-providers/:provider', authenticated, route(async(request, response) => {
    const caller = await manager(request);
    const name = provider(request.params.provider);
    const removed = await db.query(
      'DELETE FROM server_provider_credentials WHERE org_id = $1 AND provider = $2',
      [caller.orgId, name],
    );
    if (removed.rowCount) {
      await audit(caller.userId, caller.orgId, 'server_provider_credential_removed', { provider: name });
    }
    response.json({ provider: name, removed: Boolean(removed.rowCount) });
  }));

  // Service-to-service only: Agents fetches the sealed key at run start and opens it in memory.
  router.post('/broker/server-providers/credential', route(async(request, response) => {
    const serviceId = request.header('x-sulla-service-id');
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (serviceId !== sync.providersServiceId || !safeTokenEqual(token, sync.providersServiceToken)) {
      throw new ProviderError(401, 'invalid_service_identity');
    }
    const orgId = request.body?.organizationId;
    if (typeof orgId !== 'string' || !UUID.test(orgId)) throw new ProviderError(400, 'organization_required');
    const name = provider(request.body?.provider);
    const claims = (request.body?.claims ?? {}) as Record<string, unknown>;
    const agentId = typeof claims.agent_id === 'string' && IDENTIFIER.test(claims.agent_id) ? claims.agent_id : null;
    const podId = typeof claims.pod_id === 'string' && IDENTIFIER.test(claims.pod_id) ? claims.pod_id : null;
    const sub = typeof claims.sub === 'string' && UUID.test(claims.sub) ? claims.sub : null;
    const row = await db.query<{
      sealed_credential:     SealedCredential;
      recipient_fingerprint: string;
      revision:              string;
      updated_by:            string | null;
      created_by:            string;
    }>(
      `SELECT p.sealed_credential, p.recipient_fingerprint, p.revision::text, p.updated_by, o.created_by
         FROM orgs o
         LEFT JOIN server_provider_credentials p ON p.org_id = o.id AND p.provider = $2
        WHERE o.id = $1`,
      [orgId, name],
    );
    const found = row.rows[0];
    if (!found) throw new ProviderError(404, 'not_found');
    // The audit row needs a person: the member the run acts for, else whoever set the key, else the org's creator.
    const onBehalf = sub && await findMember(db, sub, orgId) ? sub : null;
    const actor = onBehalf ?? found.updated_by ?? found.created_by;
    const metadata: Record<string, string> = { provider: name, serviceId: sync.providersServiceId };
    if (agentId) metadata.agentId = agentId;
    if (!found.sealed_credential) {
      await audit(actor, orgId, 'agent_provider_credential_use', metadata, true, podId);
      throw new ProviderError(404, 'not_found');
    }
    await audit(actor, orgId, 'agent_provider_credential_use', metadata, false, podId);
    response.json({
      provider:             name,
      revision:             Number(found.revision),
      sealedCredential:     found.sealed_credential,
      recipientFingerprint: found.recipient_fingerprint,
    });
  }));

  router.use((error: unknown, _request: Request, response: Response, next: NextFunction) => {
    if (!(error instanceof ProviderError)) {
      next(error);
      return;
    }
    response.status(error.status).json({ error: error.code });
  });

  return router;
}
