/**
 * ChannelTagExtractor — extracts <channel:NAME>…</channel:NAME> tags from
 * LLM output and routes the body to the target agent's IPC channel.
 *
 * Pattern (from ActiveAgentsRegistry.buildContextBlock):
 *   <channel:heartbeat>Are you online?</channel:heartbeat>
 *   <channel:workbench>Update task #42</channel:workbench>
 *
 * Lifecycle per LLM call:
 *   • processChunk: strips any fully-closed channel blocks from the visible
 *     stream and dispatches each to its target channel via IpcMessageBus.
 *     Also truncates after a partially-streamed opening tag so `<channel:…`
 *     never leaks into the chat bubble.
 *   • processComplete: final sweep over the full content — catches any
 *     blocks that were split across chunk boundaries.
 *
 * Fire-and-forget: we do NOT wait for a reply. If the target agent
 * responds, its reply arrives on the sender's channel via the regular
 * channel_message path.
 */

import { getWebSocketClientService } from '../services/WebSocketClientService';

import type { Extractor, StreamContext } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

// ─── Regex ──────────────────────────────────────────────────────

// Matches the whole block (DOTALL). Group 1 = channel name, Group 2 = body.
const CHANNEL_BLOCK_RE = /<channel:([\w.-]+)>([\s\S]*?)<\/channel:[\w.-]+>/gi;

// Matches a partial opening tag mid-stream, so we can truncate the
// streamed buffer before the tag surfaces in the chat bubble.
const CHANNEL_OPEN_PARTIAL_RE = /<channel:[\w.-]*$|<channel:[\w.-]+>[\s\S]*$/i;

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
    visible = visible.replace(CHANNEL_BLOCK_RE, (_full, name: string, body: string) => {
      const target = String(name).trim().toLowerCase();
      const text = String(body).trim();
      const key = `${ target }::${ text }`;
      if (!text || this.dispatchedBodies.has(key)) return '';
      this.dispatchedBodies.add(key);
      this.dispatchChannel(ctx, target, text);
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
    reply.content = reply.content.replace(CHANNEL_BLOCK_RE, (_full, name: string, body: string) => {
      const target = String(name).trim().toLowerCase();
      const text = String(body).trim();
      const key = `${ target }::${ text }`;
      if (text && !this.dispatchedBodies.has(key)) {
        this.dispatchedBodies.add(key);
        this.dispatchChannel(ctx, target, text);
      }
      return '';
    });

    // Also strip any unclosed opening tag leftover.
    reply.content = reply.content.replace(/<channel:[\w.-]+>[\s\S]*$/i, '').trim();

    return reply.content;
  }

  reset(): void {
    this.buffer = '';
    this.dispatchedBodies.clear();
  }

  // ─── Internal ───────────────────────────────────────────────

  private dispatchChannel(ctx: StreamContext, targetChannel: string, body: string): void {
    try {
      const senderChannel = ctx.channel || (ctx.state as any)?.metadata?.wsChannel || 'unknown';
      const senderId = senderChannel;

      const ws = getWebSocketClientService();
      void ws.send(targetChannel, {
        type: 'chat_message',
        data: {
          content:       body,
          kind:          'channel_message',
          role:          'assistant',
          senderId,
          senderChannel,
        },
      });

      console.log(`[ChannelTagExtractor] routed → channel="${ targetChannel }" from="${ senderChannel }" chars=${ body.length }`);
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
