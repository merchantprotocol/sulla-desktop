// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.


import { createHash } from 'node:crypto';

import type { ScopedRelayTerminal, ScopedRelayTerminalStore } from './DesktopRelayPorts';

type Receipt = Parameters<ScopedRelayTerminalStore['acknowledge']>[0];

interface TerminalDatabase {
  query<T>(sql: string, values: string[]): Promise<T[]>;
  transaction<T>(work: (client: { query(sql: string, values: string[]): Promise<{ rowCount: number | null }> }) => Promise<T>): Promise<T>;
}

export class DesktopRelayTerminalRepository implements ScopedRelayTerminalStore {
  constructor(private readonly db: TerminalDatabase) {}

  private id(status: Pick<ScopedRelayTerminal, 'thread' | 'run' | 'accountId' | 'workspaceId' | 'hostDeviceId'>): string {
    return 'relay_outcome_' + createHash('sha256')
      .update(JSON.stringify([status.accountId, status.workspaceId, status.hostDeviceId, status.thread, status.run])).digest('hex');
  }

  private content(run: string, outcome: unknown): string {
    return JSON.stringify({ sullaCard: { version: 1, kind: 'run_outcome', runId: run, outcome } });
  }

  async commit(status: ScopedRelayTerminal): Promise<boolean> {
    const { thread, run, accountId, workspaceId, hostDeviceId, viewerId, viewerKey, outcome } = status;
    const id = this.id(status);
    const content = this.content(run, outcome);
    // Existing local chat store, exact acceptance receipt, no generic sync
    // queue, transcript text, or conversation metadata mutation.
    return this.db.transaction(async client => {
      const parent = await client.query(`
        SELECT c.id FROM claude_conversations c JOIN claude_messages accepted ON accepted.conversation_id=c.id
        WHERE c.id=$1 AND c.contractor_id=$2 AND c.relay_workspace_id=$3 AND c.relay_host_device_id=$4
          AND c.deleted_at IS NULL AND accepted.id=$5 AND accepted.contractor_id=$2 AND accepted.role='user'
          AND accepted.status='sent' AND accepted.routed_to='desktop' AND accepted.deleted_at IS NULL
        FOR UPDATE OF c, accepted`, [thread, accountId, workspaceId, hostDeviceId, run]);
      if (!parent.rowCount) return false;
      const inserted = await client.query(`
        INSERT INTO claude_messages (id, contractor_id, conversation_id, role, content, status, routed_to, relay_terminal_pending)
        VALUES ($1,$2,$3,'tool',$4,'sent','desktop',$5::jsonb)
        ON CONFLICT (id) DO NOTHING RETURNING id`, [id, accountId, thread, content, JSON.stringify({ run, outcome, viewerId, viewerKey })]);
      if (inserted.rowCount) return true;
      const prior = await client.query(`
        SELECT id FROM claude_messages WHERE id=$1 AND contractor_id=$2 AND conversation_id=$3
          AND role='tool' AND routed_to='desktop' AND status='sent' AND content=$4 AND deleted_at IS NULL`,
      [id, accountId, thread, content]);
      return Boolean(prior.rowCount);
    });
  }

  pending(account: string, host: string, after: string): ReturnType<ScopedRelayTerminalStore['pending']> {
    return this.db.query(`
      SELECT m.id, c.id AS thread, c.contractor_id AS "accountId", c.relay_workspace_id AS "workspaceId",
        c.relay_host_device_id AS "hostDeviceId", m.relay_terminal_pending->>'run' AS run,
        m.relay_terminal_pending->>'outcome' AS outcome, m.relay_terminal_pending->>'viewerId' AS "viewerId",
        m.relay_terminal_pending->>'viewerKey' AS "viewerKey"
      FROM claude_messages m JOIN claude_conversations c ON c.id=m.conversation_id AND c.contractor_id=m.contractor_id
      JOIN claude_messages accepted ON accepted.id=m.relay_terminal_pending->>'run'
        AND accepted.conversation_id=c.id AND accepted.contractor_id=c.contractor_id
      WHERE m.contractor_id=$1 AND c.relay_host_device_id=$2 AND m.id>$3
        AND c.relay_workspace_id IS NOT NULL AND c.deleted_at IS NULL
        AND m.relay_terminal_pending IS NOT NULL AND m.deleted_at IS NULL
        AND accepted.role='user' AND accepted.status='sent' AND accepted.routed_to='desktop' AND accepted.deleted_at IS NULL
      ORDER BY m.id LIMIT 32`, [account, host, after]);
  }

  async acknowledge(receipt: Receipt): Promise<void> {
    const { thread, run, accountId, workspaceId, hostDeviceId, outcome } = receipt;
    if (outcome !== 'completed' && outcome !== 'failed' && outcome !== 'stopped') return;
    await this.db.query(`
      UPDATE claude_messages m SET relay_terminal_pending=NULL FROM claude_conversations c
      WHERE m.id=$1 AND m.contractor_id=$2 AND c.id=$3 AND m.conversation_id=c.id
        AND c.contractor_id=$2 AND c.relay_workspace_id=$4 AND c.relay_host_device_id=$5
        AND m.relay_terminal_pending->>'run'=$6 AND m.relay_terminal_pending->>'outcome'=$7`,
    [this.id(receipt), accountId, thread, workspaceId, hostDeviceId, run, outcome]);
  }
}
