# Sulla Mobile ↔ Desktop Relay Protocol (v2 — Conversation Isolation & Durability)

**Status: BINDING SPEC.** This document defines the required behavior for chat between
Sulla Mobile and Sulla Desktop over the Cloudflare DesktopRelay. It exists because the
v1 implementation cross-contaminated conversations and lost messages. Any change to the
relay path in sulla-mobile, sulla-desktop, or sulla-workers MUST conform to this spec.
A copy lives in both sulla-mobile/docs and sulla-desktop/docs — keep them identical.

## Design principles (non-negotiable)

1. **The frame is the routing authority.** Every frame in both directions carries
   `conversationId`. Receivers route by the frame's `conversationId` — NEVER by
   "currently open conversation", NEVER by callbacks captured at send time,
   NEVER by a room/user fallback.
2. **Persist before transmit.** A user message is written to local SQLite before any
   socket send. An assistant message is scribed on desktop before the frame is sent.
   The socket is a delivery optimization; SQLite + sync is the source of truth.
3. **Idempotency everywhere.** Every message has one durable id minted by its creator
   (`userMessageId` on mobile, derived deterministic id on desktop). Every write path
   is an upsert / ON CONFLICT DO NOTHING. Retries and replays must be harmless.
4. **The relay is a dumb, lossy pipe.** DesktopRelay (workers DO) forwards frames FIFO
   and drops them when the peer is offline (`error:peer_offline`). Both ends must
   assume any frame can be lost and recover via the durable path (sync_log journal +
   `GET /chat/conversations/:id/messages?since=`).
5. **Per-conversation state only.** Run state, thinking state, keepalives, stream
   buffers, and activity dedupe are keyed by conversationId. Nothing about a
   conversation lives in a global/singleton slot.

## Frame envelope

Every chat-path frame (both directions) includes:

```
{
  type: string,            // chat | chunk | activity | message | done | stopped | error | ack
  conversationId: string,  // REQUIRED. UUID minted by mobile at conversation creation.
  ...typeSpecific
}
```

Mobile → Desktop `chat`:
`{ type:'chat', conversationId, userMessageId, messages:[{role:'user',content}], targetDeviceId }`
- `userMessageId` is REQUIRED — it is the message's durable primary key on both ends.

Desktop → Mobile: `chunk {delta}`, `activity {content}`, `message {id, content}`,
`done {id?, content?}`, `stopped`, `error {reason}` — each with `conversationId`.
Desktop MUST stamp the originating run's conversationId on every outbound frame;
a frame that would go out without one is a bug — log loudly and drop it.

## Mobile requirements

M1. **Central frame router.** One handler owns the socket's onmessage. It routes every
    frame by `frame.conversationId` into a per-conversation registry
    (Map<conversationId, ConvoState{ messages, runActive, thinkingLog, streamBuffer }>).
    Screen callbacks subscribe to a conversation; they never own frame handling.
    A frame with no conversationId (legacy desktop) may fall back to the conversation
    of the most recent outstanding run ONLY if exactly one run is outstanding;
    otherwise it is persisted to a quarantine log and NOT rendered.
M2. **Persist on arrival, render from store.** `message`/`done` frames upsert into
    claude_messages (via ChatMessageStore) under frame.conversationId immediately,
    regardless of which screen is open. UI renders from the store/registry.
M3. **Outbox.** User sends: (a) upsert local claude_messages row (status='pending'),
    (b) append {conversationId, userMessageId, content, ts} to a persisted outbox
    (SQLite or MMKV), (c) attempt socket send. On ack/`done` → mark sent, remove from
    outbox. On send failure / peer_offline / reconnect → FIFO drain per conversation
    with exponential backoff (30s/60s/90s/120s cap). Desktop dedupes by userMessageId
    so re-sends are safe.
M4. **Per-conversation run state.** `runActive`, thinking indicator, and stream buffer
    are per-conversation. The foreground conversation's state drives the UI; background
    conversations accumulate silently (badge/preview update only). Switching
    conversations neither clears nor adopts another conversation's run state.
M5. **Supersede guard.** Socket handlers capture their own socket instance and check
    identity (`if (ws !== this.socket) return`) so a stale socket's late events can't
    corrupt the current connection's state.
M6. **Catch-up remains the durable safety net.** ChatCatchupService (sync_log journal →
    `GET /chat/conversations/:id/messages?since=`) backfills anything the socket
    missed. Upserts are idempotent with live frames (same message ids).

## Desktop requirements

D1. **conversationId is mandatory inbound.** A `chat` frame without conversationId is
    rejected with `error {reason:'missing_conversation_id', userMessageId}` — NO
    fallback to currentRoom/pairedMobileUserId.
D2. **Dedupe inbound by userMessageId.** Before dispatching a run, check whether
    userMessageId was already scribed; if so, ack and skip (outbox retries arrive here).
D3. **Outbound frames carry the run's conversationId.** The bridge maps agent
    thread/run → originating mobile conversationId and stamps it on every chunk /
    activity / message / done / stopped / error frame.
D4. **Per-conversation state.** Keepalive timers, activity dedupe (lastActivity),
    stream buffers, final-text buffers: all keyed by conversationId. No '__default__'
    shared keys.
D5. **Scribe before send** (already: scribeRelayTurn) and queue outbound frames while
    the socket is down (pendingFrames), draining FIFO on reconnect. Frames dropped by
    the relay are recovered by mobile catch-up (M6) — acceptable, because persistence
    happened first.
D6. **Concurrent runs.** Two conversations may run simultaneously; nothing about one
    run may touch the other's state.

## Workers requirements

W1. DesktopRelay stays a dumb FIFO pipe (no buffering) — durability is sync_log +
    chat message endpoints, NOT the relay.
W2. The claude_conversation journal (`abe5726`, feat/chat-conversation-sync-log) must
    be deployed for mobile catch-up to detect dirty conversations. Until deployed,
    catch-up only covers conversations already known dirty via other writes.

## Recovery matrix

| Failure | Recovery |
|---|---|
| Mobile socket down at send | Outbox holds message; FIFO drain on reconnect; desktop dedupes by userMessageId |
| Desktop offline (peer_offline) | Same as above — relay drops frame, outbox retries |
| Desktop reply while mobile offline | Scribed on desktop → synced to workers → mobile catch-up backfills by `since=` |
| Stale frame arrives after user switched conversations | Routed by frame.conversationId into its own conversation store; foreground UI untouched |
| Duplicate delivery (retry + replay) | Idempotent upsert by userMessageId / message id on both ends |
| App cold start with queued sends | Outbox persisted; drained after auth + socket open |
