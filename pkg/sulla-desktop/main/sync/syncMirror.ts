// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Sync mirror — persists desktop-originated chat messages into
 * `claude_messages` + `claude_conversations` alongside the JSONL log files
 * SullaLogger already writes.
 *
 * Why: `conversation_history` stores only metadata and `SullaLogger.log()`
 * appends message content to on-disk JSONL files. To get a single
 * queryable history of every Sulla chat (desktop + mobile) we mirror the
 * user/assistant turns of primary conversations into the same Postgres
 * tables the sync pipeline already uses. Everything then flows back out
 * to the cloud (and other devices) through the normal sync-push cycle.
 *
 * What we mirror:
 *   - role === 'user' | 'assistant' only (skip 'system' + internal chatter)
 *   - conversationId starting with 'thread_' (primary graph chats)
 *     — excludes 'subconscious_', 'workflow-…', observation/memory-recall
 *       runs, and anything else that isn't a user-facing exchange.
 *
 * Idempotency: claude_conversations is UPSERTed with ON CONFLICT (preserves
 * earlier title/created_at). claude_messages uses a content-derived id so
 * the same turn isn't inserted twice if SullaLogger re-emits (which it
 * shouldn't, but defensive).
 */

import crypto from 'crypto';

import { postgresClient } from '@pkg/agent/database/PostgresClient';
import type { ScopedRelayBinding, ScopedRelayRunBinding } from '@pkg/main/cloud/relay/DesktopRelayPorts';
import { getActiveContractorId, getCurrentUserId } from '@pkg/main/sullaCloudAuth';

import { enqueueSyncOp } from './syncQueue';

async function conversationSyncEnabled(): Promise<boolean> {
  try {
    const { getCloudPreferences } = await import('@pkg/main/cloud/cloudSettings');
    const prefs = await getCloudPreferences();
    return prefs.enabled && prefs.conversations;
  } catch {
    return false;
  }
}

function isPrimaryChatConversation(conversationId: string): boolean {
  // Primary graph chats use `thread_<ts>_<n>` ids. Anything else — workflow
  // traces, subconscious agents, observation runs — is internal and should
  // not be mirrored.
  return typeof conversationId === 'string' && conversationId.startsWith('thread_');
}

export function deriveMessageId(conversationId: string, role: string, content: string, ts: string): string {
  // Deterministic id so a repeated logMessage call can't duplicate the row.
  const h = crypto
    .createHash('sha1')
    .update(`${ conversationId }|${ role }|${ ts }|${ content.slice(0, 512) }`)
    .digest('hex');
  return `msg_${ h.slice(0, 32) }`;
}

function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${ t.slice(0, max - 1) }…`;
}

interface MirrorInput {
  conversationId: string;
  role:           string;
  content:        string;
  ts:             string;
  /**
   * Explicit message id. When the turn already has an identity on another
   * device (mobile inserts its user turn locally before relaying it), writing
   * under that same id lets ON CONFLICT dedup collapse the copies everywhere
   * — local, cloud, and the other device — instead of the same logical turn
   * living under two different row ids. Omitted → derived content-hash id.
   */
  id?:            string;
  delivery?: ScopedRelayRunBinding & { run: string };
}

// Mobile user turns relayed into a desktop thread, waiting for the logger
// mirror to write them. The phone already saved each turn under its own id;
// without this the mirror wrote a second, content-derived id and the phone
// showed every message twice.
const RELAY_ID_TTL_MS = 5 * 60_000;
const pendingRelayUserIds = new Map<string, { content: string, id: string, at: number }[]>();

function claimRelayUserId(conversationId: string, content: string): string | undefined {
  const pending = pendingRelayUserIds.get(conversationId);
  if (!pending) return undefined;
  const now = Date.now();
  const live = pending.filter(p => now - p.at < RELAY_ID_TTL_MS);
  const text = content.trim();
  const i = live.findIndex(p => text === p.content || text.startsWith(`${ p.content }\n`));
  const id = i >= 0 ? live.splice(i, 1)[0].id : undefined;
  if (live.length) pendingRelayUserIds.set(conversationId, live);
  else pendingRelayUserIds.delete(conversationId);
  return id;
}

export async function mirrorMessageToClaudeMessages(input: MirrorInput): Promise<void> {
  if (!isPrimaryChatConversation(input.conversationId)) return;
  const id = input.id ?? (input.role === 'user' ? claimRelayUserId(input.conversationId, input.content) : undefined);
  await writeTurnToSyncLog(id ? { ...input, id } : input);
}

/**
 * Scribe a mobile-relay conversation turn into the sync log.
 *
 * Relay conversations are keyed by the MOBILE client's conversationId — not
 * a `thread_…` id — so they fail the primary-chat filter above by design.
 * This entry point is for the desktop relay, which is the authoritative
 * scribe for those conversations: every committed turn must land in
 * claude_messages regardless of whether the WebSocket delivery succeeded.
 *
 * `thread_…` ids are declined here: those conversations are desktop graph
 * chats whose turns the SullaLogger mirror already writes, and accepting
 * them would double-insert rows under differing derived ids.
 *
 * Unlike the desktop mirror, relay turns may carry role 'tool' — activity
 * lines persisted so mobile's history view can show tool calls alongside
 * the chat turns.
 */
export async function admitRelayThread(thread: string, existing: boolean, scope?: ScopedRelayBinding): Promise<boolean> {
  const contractor = await getActiveContractorId();
  if (!contractor || (thread.startsWith('remote_') !== Boolean(scope))
      || (scope && (contractor !== scope.accountId || await getCurrentUserId() !== scope.accountId))) return false;
  const local = await postgresClient.query(
    `SELECT 1 FROM conversation_history WHERE (thread_id = $1 OR id = $1)
       AND channel_id IS DISTINCT FROM 'mobile-relay' LIMIT 1`,
    [thread],
  );
  if (local.length) return false;
  if (scope) {
    const [row] = await postgresClient.query<{
      contractor_id: string; relay_workspace_id: string | null; relay_host_device_id: string | null; deleted_at: string | null;
    }>('SELECT contractor_id, relay_workspace_id, relay_host_device_id, deleted_at FROM claude_conversations WHERE id=$1', [thread]);
    if (!row) return !existing;
    if (row.deleted_at || row.contractor_id !== scope.accountId || row.relay_workspace_id !== scope.workspaceId
        || row.relay_host_device_id !== scope.hostDeviceId) return false;
  }
  if (!existing) return true;
  const receipt = await postgresClient.query(
    `SELECT 1 FROM claude_messages WHERE conversation_id = $1 AND contractor_id = $2
       AND role = 'user' AND status = 'sent' AND routed_to = 'desktop' AND deleted_at IS NULL LIMIT 1`,
    [thread, contractor],
  );
  return receipt.length > 0;
}

export async function scribeRelayTurn(input: MirrorInput): Promise<void> {
  if (isPrimaryChatConversation(input.conversationId)) {
    // The logger mirror writes thread turns; hand it the phone's id.
    const content = input.content.trim();
    if (input.role === 'user' && input.id && content) {
      const pending = pendingRelayUserIds.get(input.conversationId) ?? [];
      pending.push({ content, id: input.id, at: Date.now() });
      pendingRelayUserIds.set(input.conversationId, pending);
    }
    return;
  }
  await new RelayCommitWriter(postgresClient, getActiveContractorId, conversationSyncEnabled).write(input);
}

/**
 * The existing message row is the acceptance receipt. Never dispatch based
 * on a read-before-write check: only the transaction that inserts this row
 * may start execution. A lost commit response is deliberately ambiguous;
 * retrying reads the receipt but does not run again.
 */
export async function acceptRelayUserTurn(input: MirrorInput & { id: string; scope?: ScopedRelayBinding }): Promise<'accepted' | 'duplicate' | 'conflict'> {
  const { conversationId, content, ts, id, scope } = input;
  const pending = input.delivery;
  const contractorId = await getActiveContractorId();
  if (!contractorId || !id || !conversationId || !content.trim()) throw new Error('relay_acceptance_unavailable');
  if (conversationId.startsWith('remote_') !== Boolean(scope)
      || (scope && (contractorId !== scope.accountId || await getCurrentUserId() !== scope.accountId))) return 'conflict';
  // Keep scoped content on the accepting host until the shared writer can
  // authenticate the immutable workspace/host and current consent.
  const sync = !scope && await conversationSyncEnabled();
  const result = await postgresClient.transaction(async(client): Promise<'accepted' | 'duplicate' | 'conflict'> => {
    const native = await client.query(
      `SELECT 1 FROM conversation_history WHERE (thread_id = $1 OR id = $1)
         AND channel_id IS DISTINCT FROM 'mobile-relay' LIMIT 1`,
      [conversationId],
    );
    if (native.rows.length) return 'conflict';
    const conversation = await client.query(
      `INSERT INTO claude_conversations
         (id, contractor_id, title, status, last_message_at, last_message_preview, unread_count, created_at, updated_at, relay_workspace_id, relay_host_device_id)
       VALUES ($1, $2, $3, 'active', $4, $5, 0, $4, $4, $6, $7)
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [conversationId, contractorId, truncate(content, 60), ts, truncate(content, 100), scope?.workspaceId ?? null, scope?.hostDeviceId ?? null],
    );
    if (!conversation.rowCount) {
      const owned = await client.query(
        `SELECT id FROM claude_conversations WHERE id = $1 AND contractor_id = $2 AND deleted_at IS NULL
           AND relay_workspace_id IS NOT DISTINCT FROM $3 AND relay_host_device_id IS NOT DISTINCT FROM $4 FOR UPDATE`,
        [conversationId, contractorId, scope?.workspaceId ?? null, scope?.hostDeviceId ?? null],
      );
      if (!owned.rowCount) return 'conflict';
    }

    const queue = scope && pending?.run === id
      ? JSON.stringify({ run: id, viewerId: pending.viewerId, viewerKey: pending.viewerKey }) : null;
    const inserted = await client.query(
      `INSERT INTO claude_messages
         (id, contractor_id, conversation_id, role, content, status, routed_to, created_at, updated_at${queue ? ', relay_history_pending' : ''})
       VALUES ($1, $2, $3, 'user', $4, 'sent', 'desktop', $5, $5${queue ? ', $6::jsonb' : ''})
       ON CONFLICT (id) DO NOTHING RETURNING id`,
      [id, contractorId, conversationId, content, ts, ...(queue ? [queue] : [])],
    );
    if (!inserted.rowCount) {
      const receipt = await client.query(
        `SELECT id FROM claude_messages
          WHERE id = $1 AND contractor_id = $2 AND conversation_id = $3 AND role = 'user'
            AND content = $4 AND status = 'sent' AND routed_to = 'desktop' AND deleted_at IS NULL`,
        [id, contractorId, conversationId, content],
      );
      // A queued/synced or foreign row does not prove acceptance. Fail closed
      // instead of acknowledging it or attempting a potentially ambiguous repeat.
      if (!receipt.rowCount) throw new RelayMessageConflict();
      return 'duplicate';
    }

    await client.query(
      `UPDATE claude_conversations SET last_message_at = $2, last_message_preview = $3, updated_at = $2 WHERE id = $1`,
      [conversationId, ts, truncate(content, 100)],
    );
    if (sync) {
      for (const [table, key] of [['claude_conversation', conversationId], ['claude_message', id]]) {
        await client.query(
          `INSERT INTO sync_queue (id, table_name, record_key, operation)
           VALUES ($1, $2, $3, 'upsert')
           ON CONFLICT (table_name, record_key) DO UPDATE SET
             operation = EXCLUDED.operation, created_at = CURRENT_TIMESTAMP`,
          [crypto.randomUUID(), table, JSON.stringify({ id: key })],
        );
      }
    }
    return 'accepted';
  }).catch((err: unknown) => {
    if (err instanceof RelayMessageConflict) return 'conflict' as const;
    throw err;
  });

  if (result === 'accepted' && isPrimaryChatConversation(conversationId)) {
    // Let the graph's normal user-turn mirror reuse the row just committed.
    const pending = pendingRelayUserIds.get(conversationId) ?? [];
    pending.push({ content: content.trim(), id, at: Date.now() });
    pendingRelayUserIds.set(conversationId, pending);
  }
  if (result === 'accepted' && sync) {
    void import('./SullaSyncService').then(({ SullaSync }) => SullaSync.pushSoon()).catch(() => undefined);
  }
  return result;
}

class RelayMessageConflict extends Error {}

class RelayCommitWriter {
  constructor(
    private readonly db: typeof postgresClient,
    private readonly owner: typeof getActiveContractorId,
    private readonly syncEnabled: () => Promise<boolean>,
  ) {}

  async write(input: MirrorInput): Promise<void> {
    const { conversationId, role, content, ts } = input;
    const owner = await this.owner();
    if (!owner) throw new Error('relay_history_unavailable');
    const id = input.id ?? deriveMessageId(conversationId, role, content, ts);
    const sync = !conversationId.startsWith('remote_') && await this.syncEnabled();
    await this.db.transaction(async client => {
      const thread = await client.query(
        `SELECT id FROM claude_conversations WHERE id=$1 AND contractor_id=$2 AND deleted_at IS NULL FOR UPDATE`,
        [conversationId, owner],
      );
      if (!thread.rowCount) throw new Error('relay_thread_unavailable');
      const delivery = input.delivery;
      let pending: string | null = null;
      if (delivery && role === 'assistant' && owner === delivery.accountId && conversationId.startsWith('remote_')) {
        const accepted = await client.query(`
          SELECT m.id FROM claude_conversations c JOIN claude_messages m ON m.conversation_id=c.id AND m.contractor_id=c.contractor_id
          WHERE c.id=$1 AND c.contractor_id=$2 AND c.relay_workspace_id=$3 AND c.relay_host_device_id=$4 AND c.deleted_at IS NULL
            AND m.id=$5 AND m.role='user' AND m.routed_to='desktop' AND m.status='sent' AND m.deleted_at IS NULL
        `, [conversationId, owner, delivery.workspaceId, delivery.hostDeviceId, delivery.run]);
        if (!accepted.rows.length) throw new Error('relay_receipt_unavailable');
        pending = JSON.stringify({ run: delivery.run, viewerId: delivery.viewerId, viewerKey: delivery.viewerKey });
      }
      const inserted = await client.query(
        `INSERT INTO claude_messages
          (id, contractor_id, conversation_id, role, content, status, routed_to, created_at, updated_at${pending ? ', relay_history_pending' : ''})
         VALUES ($1,$2,$3,$4,$5,'sent','desktop',$6,$6${pending ? ', $7::jsonb' : ''}) ON CONFLICT (id) DO NOTHING RETURNING id`,
        [id, owner, conversationId, role, content, ts, ...(pending ? [pending] : [])],
      );
      if (!inserted.rowCount) {
        const existing = await client.query(
          `SELECT id FROM claude_messages WHERE id=$1 AND contractor_id=$2 AND conversation_id=$3
            AND role=$4 AND content=$5 AND deleted_at IS NULL`,
          [id, owner, conversationId, role, content],
        );
        if (!existing.rowCount) throw new RelayMessageConflict();
        return;
      }
      if (role !== 'tool') {
        await client.query(
          `UPDATE claude_conversations SET last_message_at=$2,last_message_preview=$3,updated_at=$2 WHERE id=$1`,
          [conversationId, ts, truncate(content, 100)],
        );
      }
      if (sync) {
        const records = [['claude_message', id]];
        if (role !== 'tool') records.push(['claude_conversation', conversationId]);
        for (const [table, record] of records) {
          await client.query(
            `INSERT INTO sync_queue (id,table_name,record_key,operation) VALUES ($1,$2,$3,'upsert')
              ON CONFLICT (table_name,record_key) DO UPDATE SET operation=EXCLUDED.operation,created_at=CURRENT_TIMESTAMP`,
            [crypto.randomUUID(), table, JSON.stringify({ id: record })],
          );
        }
      }
    });
    if (sync) void import('./SullaSyncService').then(({ SullaSync }) => SullaSync.pushSoon()).catch(() => undefined);
  }
}

async function writeTurnToSyncLog(input: MirrorInput): Promise<void> {
  const { conversationId, role, content, ts } = input;

  if (!conversationId) return;
  if (role !== 'user' && role !== 'assistant' && role !== 'tool') return;
  if (!content?.trim()) return;

  let contractorId = '';
  try {
    contractorId = await getActiveContractorId();
  } catch { /* not signed in or DB not ready */ }
  // Without a contractor we can't write a valid row that survives sync.
  // The local JSONL log is already captured by SullaLogger — just skip
  // the mirror until the user signs in.
  if (!contractorId) return;

  const preview = truncate(content, 100);
  const title = truncate(content, 60);
  const msgId = input.id || deriveMessageId(conversationId, role, content, ts);

  try {
    // Ensure a conversation row exists (idempotent). The title is only set
    // on INSERT — ON CONFLICT keeps whatever the user / auto-title chose.
    // Tool/activity rows don't drive the conversation list: they never
    // create a conversation or clobber its preview with tool chatter.
    if (role !== 'tool') {
      await postgresClient.query(
        `INSERT INTO claude_conversations
           (id, contractor_id, title, status, last_message_at,
            last_message_preview, unread_count, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $5, 0, $4, $4)
         ON CONFLICT (id) DO UPDATE SET
           last_message_at      = EXCLUDED.last_message_at,
           last_message_preview = EXCLUDED.last_message_preview,
           updated_at           = EXCLUDED.updated_at`,
        [conversationId, contractorId, title, ts, preview],
      );
    }

    // Insert the message. Deterministic id means duplicates are safe.
    await postgresClient.query(
      `INSERT INTO claude_messages
         (id, contractor_id, conversation_id, role, content, status,
          routed_to, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, 'sent', 'desktop', $6, $6)
       ON CONFLICT (id) DO NOTHING`,
      [msgId, contractorId, conversationId, role, content, ts],
    );

    // Local history is always kept. Cloud push only when the owner turned
    // on conversation sync (Settings → Sulla Cloud; off by default).
    if (!(await conversationSyncEnabled())) return;

    // Enqueue for sync push so mobile and the cloud see the turn.
    if (role !== 'tool') {
      await enqueueSyncOp('claude_conversation', { id: conversationId }, 'upsert');
    }
    await enqueueSyncOp('claude_message', { id: msgId }, 'upsert');

    // Trigger an eager push so there's no 15s lag before mobile sees it.
    try {
      const { SullaSync } = await import('./SullaSyncService');
      SullaSync.pushSoon();
    } catch { /* service may not be initialized yet */ }
  } catch (err) {
    console.warn('[SyncMirror] Failed to mirror message:', err);
  }
}
