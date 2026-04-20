/**
 * Sync dispatcher — kicks off Claude Code when a pulled claude_message
 * needs a response. Used as the offline-friendly fallback for the WS
 * relay: if mobile sent a user turn tagged `routed_to='desktop'` while
 * the WS was down, the message still lands in the cloud queue, desktop
 * pulls it here, and this function runs Claude and pushes the reply back.
 *
 * Dedup:
 *   - Before invoking Claude, re-check the local DB for an assistant
 *     reply after the user message's timestamp. The WS path may already
 *     have handled it and written the reply; applyRemote ran first.
 *   - A process-local inFlight set keeps a concurrent pull + WS race
 *     from spawning two Claude subprocesses for the same message id.
 */

import crypto from 'crypto';

import { postgresClient } from '@pkg/agent/database/PostgresClient';

import { enqueueSyncOp } from './syncQueue';

interface PulledUserMessage {
  id:              string;
  contractor_id:   string;
  conversation_id: string;
  created_at:      string;
}

// Message ids currently being handled by this process. Cleared when Claude
// returns (success or failure). Prevents duplicate Claude spawns if the
// same message id is pulled twice before the reply is written.
const inFlight = new Set<string>();

export async function dispatchClaudeForMessage(msg: PulledUserMessage): Promise<void> {
  if (inFlight.has(msg.id)) return;

  // Idempotency check: is there already a more-recent assistant reply in
  // this conversation? If yes, skip — the WS path handled it or we pulled
  // the reply in the same cycle.
  const existing = await postgresClient.query<{ id: string }>(
    `SELECT id FROM claude_messages
     WHERE conversation_id = $1
       AND role = 'assistant'
       AND deleted_at IS NULL
       AND created_at >= $2
     ORDER BY created_at DESC
     LIMIT 1`,
    [msg.conversation_id, msg.created_at],
  );
  if (existing.length > 0) {
    return;
  }

  inFlight.add(msg.id);
  try {
    // Pull the full conversation history — same shape ClaudeCodeService
    // gets from BaseNode.normalizedChat, minus the system-role prompt (we
    // rely on ClaudeCodeService's buildFullSystemPrompt fallback for that).
    const history = await postgresClient.query<{ role: string; content: string; created_at: string }>(
      `SELECT role, content, created_at
       FROM claude_messages
       WHERE conversation_id = $1 AND deleted_at IS NULL
       ORDER BY created_at ASC`,
      [msg.conversation_id],
    );

    if (history.length === 0) {
      // Nothing to send — race condition, drop it.
      return;
    }

    const messages = history.map(h => ({
      role:    h.role as 'user' | 'assistant' | 'system',
      content: h.content ?? '',
    }));

    const { getClaudeCodeService } = await import('@pkg/agent/languagemodels/ClaudeCodeService');
    const svc = getClaudeCodeService();

    // We don't stream to a UI here — sync-dispatched runs produce a
    // written reply that flows back through the sync log to whichever
    // client is listening. Discard tokens; capture the final text.
    const result = await svc.chatStream(
      messages,
      { onToken: () => { /* discard */ } },
      { conversationId: msg.conversation_id },
    );

    const reply = result?.content?.trim() ?? '';
    if (!reply) {
      console.warn(`[SyncDispatcher] Claude returned empty reply for message ${ msg.id }`);
      return;
    }

    const replyId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Insert the assistant reply locally AND record the conversation
    // metadata update. Both get enqueued for push so the cloud (and any
    // other clients) see the completion.
    await postgresClient.query(
      `INSERT INTO claude_messages
         (id, contractor_id, conversation_id, role, content, status,
          routed_to, created_at, updated_at)
       VALUES ($1, $2, $3, 'assistant', $4, 'sent', 'desktop', $5, $5)`,
      [replyId, msg.contractor_id, msg.conversation_id, reply, now],
    );

    const preview = reply.length > 100 ? `${ reply.slice(0, 100) }...` : reply;
    await postgresClient.query(
      `UPDATE claude_conversations
       SET last_message_at      = $1,
           last_message_preview = $2,
           updated_at           = $1
       WHERE id = $3`,
      [now, preview, msg.conversation_id],
    );

    await enqueueSyncOp('claude_message', { id: replyId }, 'upsert');
    await enqueueSyncOp('claude_conversation', { id: msg.conversation_id }, 'upsert');

    // Prompt an immediate push so the mobile client sees the reply on its
    // next pull (or the current WS tick, whichever it's doing).
    try {
      const { SullaSync } = await import('./SullaSyncService');
      SullaSync.pushSoon();
    } catch { /* service may not be initialized yet */ }
  } catch (err) {
    console.warn(`[SyncDispatcher] Claude dispatch failed for ${ msg.id }:`, err);
  } finally {
    inFlight.delete(msg.id);
  }
}
