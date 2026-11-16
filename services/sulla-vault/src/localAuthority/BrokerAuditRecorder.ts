// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { BrokerExecuteRequest } from '../contracts.js';
import type { Queryable } from '../db.js';
import type { LocalAuthorityHost } from './LocalAuthorityHost.js';
import { UUID_PATTERN } from './LocalAuthorityLimits.js';
import type { ItemRow } from './LocalAuthorityTypes.js';

/**
 * Records agent credential use and broker denials in the rotating outbound audit file
 * (never Postgres, never the Files per-secret audit, never as a reveal).
 * Moved verbatim from LocalVaultAuthority (E9).
 */
export class BrokerAuditRecorder {
  constructor(private readonly host: LocalAuthorityHost) {}

  /** Agent credential use goes to the rotating file sink, never Postgres or the Files per-secret audit, and never as a reveal. */
  async audit(
    input: BrokerExecuteRequest,
    item: ItemRow,
    blocked: boolean,
    reason: string | null,
    _db?: Queryable,
  ): Promise<void> {
    this.host.outboundAudit.record({
      actorUserId: input.claims.sub, orgId: item.org_id ?? null, collectionId: item.collection_id, itemId: item.id,
      podId: input.claims.pod_id, agentId: input.claims.agent_id, operation: input.operation,
      destination: input.operation === 'item.http' ? new URL(input.url).hostname : new URL(input.url).origin,
      blocked, reason,
    });
  }

  async auditBrokerDenial(input: BrokerExecuteRequest, reason: string): Promise<void> {
    let destination: string | undefined;
    try {
      const parsed = new URL(input.url);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') destination = input.operation === 'item.http' ? parsed.hostname : parsed.origin;
    } catch {
      // Invalid destinations are represented by the denial reason, never copied into audit metadata.
    }
    this.host.outboundAudit.record({
      actorUserId: input.claims.sub, podId: input.claims.pod_id, agentId: input.claims.agent_id, operation: input.operation,
      ...(input.operation === 'item.http' && UUID_PATTERN.test(input.ref?.itemId ?? '') ? { itemId: input.ref.itemId } : {}),
      ...(destination ? { destination } : {}),
      blocked: true, reason,
    });
  }
}
