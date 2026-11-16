// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import { LocalVaultError, type LocalVaultAuthority } from '../localAuthority.js';
import type { PostgresHumanActivityRepository } from '../repositories/PostgresHumanActivityRepository.js';
import { VaultHttpError, type VaultRequestInput } from './VaultRequestInput.js';

/**
 * Keeps only allow-listed, well-formed identifiers from an audit event's metadata before it is
 * shown to the human; destinations are reduced to their origin.
 */
export class AuditMetadataSanitizer {
  static readonly uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  static readonly identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,159}$/;

  sanitize(value: unknown): Record<string, string> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const input = value as Record<string, unknown>;
    const metadata: Record<string, string> = {};
    for (const key of ['agentId', 'operation', 'serviceId', 'threadId', 'jobId', 'workflowExecutionId', 'integrationId'] as const) {
      if (typeof input[key] === 'string' && AuditMetadataSanitizer.identifierPattern.test(input[key])) metadata[key] = input[key];
    }
    if (typeof input.agentName === 'string' && input.agentName.length > 0 && input.agentName.length <= 160 && !/[\u0000-\u001f\u007f]/.test(input.agentName)) {
      metadata.agentName = input.agentName;
    }
    if (typeof input.requestedItemId === 'string' && AuditMetadataSanitizer.uuidPattern.test(input.requestedItemId)) {
      metadata.requestedItemId = input.requestedItemId;
    }
    if (typeof input.destination === 'string' && input.destination.length <= 2048) {
      try {
        const destination = new URL(input.destination);
        if (destination.protocol === 'https:' || destination.protocol === 'http:') metadata.destination = destination.origin;
      } catch {
        // Invalid destinations are omitted rather than copied into the immutable audit record.
      }
    }
    return metadata;
  }
}

/**
 * GET /v1/human/activity: the unlocked human's audit feed. Postgres events and the recent
 * file-sink (agent credential use) events are merged newest-first into one paged window.
 */
export class HumanActivityRoutes {
  /** Deepest offset+limit that still merges file-sink events; deeper pages are Postgres-only. */
  static readonly auditMergeWindow = 5000;

  constructor(
    private readonly localAuthority: LocalVaultAuthority,
    private readonly activity: PostgresHumanActivityRepository,
    private readonly sanitizer: AuditMetadataSanitizer,
    private readonly input: VaultRequestInput,
  ) {}

  register(app: express.Express): void {
    const { localAuthority, activity, sanitizer } = this;
    const { humanCookie } = this.input;
    const AUDIT_MERGE_WINDOW = HumanActivityRoutes.auditMergeWindow;

    app.get('/v1/human/activity', async(request, response) => {
      const sessionId = humanCookie(request);
      const csrf = request.header('x-csrf-token');
      const session = localAuthority.humanSessionStatus(sessionId, csrf);
      const principalId = localAuthority.status().principalId;
      if (session.phase !== 'unlocked' || !principalId) throw new LocalVaultError('vault_locked', 423, 'Vault is locked');
      const limit = Math.min(Math.max(Number(request.query.limit) || 25, 1), 100);
      const offset = Math.min(Math.max(Number(request.query.offset) || 0, 0), 100_000);
      if (typeof request.query.item === 'string') {
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request.query.item)) {
          throw new VaultHttpError(400, 'item is invalid');
        }
      }
      if (request.query.actor !== 'agent' && request.query.actor !== 'human' && request.query.actor !== undefined && request.query.actor !== 'all') throw new VaultHttpError(400, 'actor is invalid');
      if (request.query.blocked !== 'true' && request.query.blocked !== undefined && request.query.blocked !== 'false') throw new VaultHttpError(400, 'blocked is invalid');
      if (typeof request.query.from === 'string') {
        if (!Number.isFinite(Date.parse(request.query.from))) throw new VaultHttpError(400, 'from is invalid');
      }
      if (typeof request.query.query === 'string') {
        const query = request.query.query.trim();
        if (query.length > 160) throw new VaultHttpError(400, 'query is too long');
      }
      // Agent credential use lives in the file sink, not Postgres. Merge its recent events
      // into the same newest-first window so limit/offset/filters behave as before.
      // Windows deeper than AUDIT_MERGE_WINDOW fall back to Postgres events only.
      const wantsFile = request.query.actor !== 'human' && offset + limit + 1 <= AUDIT_MERGE_WINDOW;
      const window = wantsFile ? offset + limit + 1 : limit + 1;
      let rows: Array<Record<string, any>> = await activity.listForPrincipal({
        principalId,
        item: typeof request.query.item === 'string' ? request.query.item : undefined,
        actor: request.query.actor,
        blocked: request.query.blocked,
        from: typeof request.query.from === 'string' ? request.query.from : undefined,
        query: typeof request.query.query === 'string' ? request.query.query : undefined,
        window,
        offset: wantsFile ? 0 : offset,
      });
      if (wantsFile) {
        const itemQuery = typeof request.query.item === 'string' ? request.query.item.toLowerCase() : null;
        const needle = typeof request.query.query === 'string' ? request.query.query.trim().toLowerCase() : '';
        const fromMs = typeof request.query.from === 'string' ? Date.parse(request.query.from) : null;
        const fileEvents = await localAuthority.outboundAuditSink.readRecent(event => {
          if (event.actor_user_id !== principalId || event.org_id !== null) return false;
          if (itemQuery && event.item_id?.toLowerCase() !== itemQuery) return false;
          if (request.query.blocked === 'true' && !event.blocked) return false;
          if (fromMs !== null && Date.parse(event.created_at) < fromMs) return false;
          if (needle) {
            const hay = [event.action, event.pod_id, event.item_id, event.metadata?.agentId, event.metadata?.operation, event.metadata?.destination]
              .map(value => typeof value === 'string' ? value.toLowerCase() : '').join('\n');
            if (!hay.includes(needle)) return false;
          }
          return true;
        }, window);
        const fileRows = fileEvents.map((event, index) => ({
          id: `file-${ event.created_at }-${ index }`, item_id: event.item_id, action: event.action, pod_id: event.pod_id,
          metadata: event.metadata, blocked: event.blocked, reason: event.reason, created_at: event.created_at,
        }));
        rows = [...rows, ...fileRows].sort((a, b) => Date.parse(String(b.created_at)) - Date.parse(String(a.created_at))).slice(offset);
      }
      const hasMore = rows.length > limit;
      const events = rows.slice(0, limit).map(event => ({ ...event, metadata: sanitizer.sanitize(event.metadata) }));
      const currentSession = localAuthority.humanSessionStatus(sessionId, csrf);
      if (currentSession.phase !== 'unlocked' || localAuthority.status().principalId !== principalId) {
        throw new LocalVaultError('vault_locked', 423, 'Vault locked during audit request');
      }
      response.json({ events, hasMore, limit, offset });
    });
  }
}
