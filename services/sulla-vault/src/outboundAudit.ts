// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { AuditFileSink } from './auditFileSink.js';

/**
 * Agent credential use is NOT a human reveal. It is recorded under its own
 * action name, to the file sink (never Postgres, never the Files per-secret
 * audit). `human_item_reveal` stays a Postgres-only, human-only action.
 */
export const AGENT_CREDENTIAL_USE_ACTION = 'agent_credential_use';
/** Name old rows carry in Postgres; only read/cleanup code should reference it. */
export const LEGACY_OUTBOUND_ACTION = 'vault_outbound_request';
export const HUMAN_REVEAL_ACTION = 'human_item_reveal';

export interface OutboundUse {
  actorUserId: string;
  orgId?: string | null;
  collectionId?: string | null;
  itemId?: string | null;
  podId?: string | null;
  agentId?: string;
  operation: string;
  /** Hostname (item.http) or origin; never a full URL with path/query. */
  destination?: string;
  blocked: boolean;
  reason?: string | null;
}

export class OutboundAuditRecorder {
  constructor(private readonly sink: AuditFileSink) {}

  record(use: OutboundUse): void {
    this.sink.write({
      action: AGENT_CREDENTIAL_USE_ACTION,
      actor_user_id: use.actorUserId,
      org_id: use.orgId ?? null,
      collection_id: use.collectionId ?? null,
      item_id: use.itemId ?? null,
      pod_id: use.podId ?? null,
      metadata: {
        agentId: use.agentId,
        operation: use.operation,
        ...(use.destination ? { destination: use.destination } : {}),
        ...(use.itemId ? { itemId: use.itemId } : {}),
      },
      blocked: use.blocked,
      reason: use.reason ?? null,
    });
  }
}
