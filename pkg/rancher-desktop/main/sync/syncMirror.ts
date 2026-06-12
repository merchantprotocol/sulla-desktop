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
import { getActiveContractorId } from '@pkg/main/sullaCloudAuth';

import { enqueueSyncOp } from './syncQueue';

function isPrimaryChatConversation(conversationId: string): boolean {
  // Primary graph chats use `thread_<ts>_<n>` ids. Anything else — workflow
  // traces, subconscious agents, observation runs — is internal and should
  // not be mirrored.
  return typeof conversationId === 'string' && conversationId.startsWith('thread_');
}

function deriveMessageId(conversationId: string, role: string, content: string, ts: string): string {
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
}

export async function mirrorMessageToClaudeMessages(input: MirrorInput): Promise<void> {
  if (!isPrimaryChatConversation(input.conversationId)) return;
  await writeTurnToSyncLog(input);
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
export async function scribeRelayTurn(input: MirrorInput): Promise<void> {
  if (isPrimaryChatConversation(input.conversationId)) return;
  await writeTurnToSyncLog(input);
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
  const msgId = deriveMessageId(conversationId, role, content, ts);

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
