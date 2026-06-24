/**
 * ChannelTagExtractor — extracts <channel:NAME>…</channel:NAME> tags from
 * LLM output and routes the body to the target agent's IPC channel.
 *
 * Pattern (from ActiveAgentsRegistry.buildContextBlock):
 *   <channel:heartbeat>Are you online?</channel:heartbeat>
 *   <channel:workbench>Update task #42</channel:workbench>
 *
 * Optional action modifiers in the opening tag:
 *   <channel:heartbeat wake>body</channel:heartbeat>
 *     → displays message + sends user_message to trigger a new agent turn
 *   <channel:heartbeat interrupt>body</channel:heartbeat>
 *     → aborts the target's running turn, then wakes with the body
 *
 * Without a modifier the message is display-only (chat_message, current
 * behaviour). With wake or interrupt, a user_message is also sent so the
 * target agent actually executes.
 *
 * Lifecycle per LLM call:
 *   • processChunk: strips any fully-closed channel blocks from the visible
 *     stream and dispatches each to its target channel via IpcMessageBus.
 *     Also truncates after a partially-streamed opening tag so `<channel:…`
 *     never leaks into the chat bubble.
 *   • processComplete: final sweep over the full content — catches any
 *     blocks that were split across chunk boundaries.
 */

import { getWebSocketClientService } from '../services/WebSocketClientService';

import type { Extractor, StreamContext } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Regex ──────────────────────────────────────────────────────

// Matches the whole block (DOTALL).
// Group 1 = channel name, Group 2 = optional attribute string, Group 3 = body.
const CHANNEL_BLOCK_RE = /<channel:([\w.-]+)([^>]*)>([\s\S]*?)<\/channel:[\w.-]+>/gi;

// Matches a partial opening tag mid-stream, so we can truncate the
// streamed buffer before the tag surfaces in the chat bubble.
const CHANNEL_OPEN_PARTIAL_RE = /<channel:[\w.-]*$|<channel:[\w.-]+[^>]*>[\s\S]*$/i;

export class ChannelTagExtractor implements Extractor {
  readonly name = 'channel';

  // Accumulated content for cross-chunk block detection.
  private buffer = '';

  // Record of what we've already dispatched (by start-index in full content).
  // Prevents double-sending when the final sweep re-scans.
  private dispatchedBodies = new Set<string>();

  enrichPrompt(systemPrompt: string): string {
    // ActiveAgentsRegistry already injects the channel protocol into the
    // prompt on every LLM call — don't duplicate it here.
    return systemPrompt;
  }

  processChunk(chunk: string, ctx: StreamContext): string {
    this.buffer += chunk;

    let visible = this.buffer;

    // 1) Dispatch + strip any fully-closed channel blocks.
    visible = visible.replace(CHANNEL_BLOCK_RE, (_full, name: string, attrs: string, body: string) => {
      const target = String(name).trim().toLowerCase();
      const text = String(body).trim();
      const key = `${ target }::${ text }`;
      if (!text || this.dispatchedBodies.has(key)) return '';
      this.dispatchedBodies.add(key);
      this.dispatchChannel(ctx, target, text, String(attrs));
      return '';
    });

    // 2) Truncate at a partial opening tag so `<channel:foo` or
    //    `<channel:foo>unfinished…` doesn't leak into the stream.
    const partial = visible.match(CHANNEL_OPEN_PARTIAL_RE);
    if (partial && partial.index !== undefined) {
      visible = visible.slice(0, partial.index);
    }

    // We've emitted `visible` so far — rebase the buffer to what remains
    // unrendered (the truncated partial tag, if any).
    const remainder = this.buffer.replace(CHANNEL_BLOCK_RE, '');
    const partialRemainder = remainder.match(CHANNEL_OPEN_PARTIAL_RE);
    this.buffer = partialRemainder ? remainder.slice(partialRemainder.index ?? 0) : '';

    // Return only the delta that hasn't been emitted yet. The controller
    // already concatenated `chunk` into its own buffer, so we must return
    // only the text the caller should *keep* from this chunk.
    //
    // Simpler + safe: compute the portion of `chunk` that survives the
    // stripping. We do this by stripping the same patterns from `chunk`
    // directly (plus truncating its partial-open tail).
    return stripFromDelta(chunk);
  }

  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    // Final sweep on the full response — catches blocks that straddled
    // chunk boundaries during streaming.
    reply.content = reply.content.replace(CHANNEL_BLOCK_RE, (_full, name: string, attrs: string, body: string) => {
      const target = String(name).trim().toLowerCase();
      const text = String(body).trim();
      const key = `${ target }::${ text }`;
      if (text && !this.dispatchedBodies.has(key)) {
        this.dispatchedBodies.add(key);
        this.dispatchChannel(ctx, target, text, String(attrs));
      }
      return '';
    });

    // Also strip any unclosed opening tag leftover (including attribute variants).
    reply.content = reply.content.replace(/<channel:[\w.-]+[^>]*>[\s\S]*$/i, '').trim();

    return reply.content;
  }

  reset(): void {
    this.buffer = '';
    this.dispatchedBodies.clear();
  }

  // ─── Internal ───────────────────────────────────────────────

  private dispatchChannel(ctx: StreamContext, targetChannel: string, body: string, attrs: string): void {
    try {
      const senderChannel = ctx.channel || (ctx.state as any)?.metadata?.wsChannel || 'unknown';
      const senderId = senderChannel;
      const isWake = /\bwake\b/i.test(attrs);
      const isInterrupt = /\binterrupt\b/i.test(attrs);

      // fromThreadId — the sender's current conversation thread.
      // toThreadId  — the thread on the sender's channel that expects the reply.
      //   For outgoing messages: this is the thread that should receive replies.
      //   For incoming wake responses: the receiver's ChannelTagExtractor reads
      //   state.metadata.replyToThread (set by BackendGraphWebSocketService when
      //   processing a wake user_message) and echoes it here.
      const fromThreadId: string = ctx.threadId || '';
      const replyToThread: string = (ctx.state as any)?.metadata?.replyToThread || '';
      // toThreadId is the thread that should receive the reply — if this agent
      // was woken by someone else, reply to their thread; otherwise no specific target.
      const toThreadId: string = replyToThread || fromThreadId || '';

      const ws = getWebSocketClientService();

      // Always send a display-only message so the body appears in the target's UI.
      void ws.send(targetChannel, {
        type: 'chat_message',
        data: {
          content:       body,
          kind:          'channel_message',
          role:          'assistant',
          senderId,
          senderChannel,
          fromThreadId:  fromThreadId || undefined,
          toThreadId:    toThreadId   || undefined,
        },
      });

      // interrupt: abort any running turn first.
      if (isInterrupt) {
        void ws.send(targetChannel, {
          type: 'stop_run',
          data: { reason: `interrupted by ${ senderChannel }` },
        });
      }

      // wake or interrupt: send user_message to trigger execution with thread context.
      if (isWake || isInterrupt) {
        void ws.send(targetChannel, {
          type: 'user_message',
          data: {
            content:  body,
            metadata: {
              source:        'channel_wake',
              senderId,
              senderChannel,
              replyToThread: fromThreadId || undefined,
            },
          },
        });
      }

      const action = isInterrupt ? 'interrupt+wake' : isWake ? 'wake' : 'message';
      console.log(`[ChannelTagExtractor] routed → channel="${ targetChannel }" from="${ senderChannel }" action=${ action } fromThread=${ fromThreadId.slice(-8) } toThread=${ toThreadId.slice(-8) } chars=${ body.length }`);
    } catch (err) {
      console.warn('[ChannelTagExtractor] dispatch failed:', err);
    }
  }
}

// Helper: strip full blocks + truncate partial opening tag from a raw
// delta chunk. Used so processChunk returns a display-safe delta.
function stripFromDelta(chunk: string): string {
  let out = chunk.replace(CHANNEL_BLOCK_RE, '');
  const partial = out.match(CHANNEL_OPEN_PARTIAL_RE);
  if (partial && partial.index !== undefined) {
    out = out.slice(0, partial.index);
  }
  return out;
}
