// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import * as crypto from 'crypto';
import { getWebSocketClientService } from '../services/WebSocketClientService';
import { resolveAgentIdentity } from '../utils/agentIdentity';

import type { Extractor, StreamContext } from './Extractor';
import type { NormalizedResponse } from '../languagemodels/BaseLanguageModel';

const OPEN = '<channel:';
const BLOCK = /<channel:([\w.-]+(?:#[\w.-]+)?)([^>]*)>([\s\S]*?)<\/channel:[\w.-]+(?:#[\w.-]+)?>/i;
const MAX_HOLDBACK = 200;
export const A2A_CARD_MARKER = '⟦SULLA_A2A:';

interface ChannelCard { id: string; to: string; targetId?: string; body: string; status: 'sent'; }

function marker(card: ChannelCard): string {
  return `${ A2A_CARD_MARKER }${ Buffer.from(JSON.stringify(card)).toString('base64url') }⟧`;
}

/** Incremental, code-aware channel-tag parser. Only incomplete trailing openers are buffered. */
export class ChannelTagExtractor implements Extractor {
  readonly name = 'channel';
  private pending = '';
  private fenced = false;
  private inlineTicks = 0;
  private dispatchedBodies = new Map<string, string>();

  enrichPrompt(systemPrompt: string): string { return systemPrompt; }

  processChunk(chunk: string, ctx: StreamContext): string {
    this.pending += chunk;
    const { output, remainder } = this.consume(this.pending, ctx, false);
    this.pending = remainder.slice(-MAX_HOLDBACK);
    return output;
  }

  processComplete(reply: NormalizedResponse, ctx: StreamContext): string {
    const input = reply.content;
    this.pending = '';
    this.fenced = false;
    this.inlineTicks = 0;
    const { output } = this.consume(input, ctx, true);
    reply.content = output.trim();
    return reply.content;
  }

  reset(): void {
    this.pending = '';
    this.fenced = false;
    this.inlineTicks = 0;
    this.dispatchedBodies.clear();
  }

  private consume(input: string, ctx: StreamContext, final: boolean): { output: string; remainder: string } {
    let output = '';
    let i = 0;
    while (i < input.length) {
      if (!this.inlineTicks && input.startsWith('```', i)) {
        this.fenced = !this.fenced;
        output += '```'; i += 3; continue;
      }
      if (!this.fenced && input[i] === '`') {
        let ticks = 1;
        while (input[i + ticks] === '`') ticks++;
        this.inlineTicks = this.inlineTicks ? (this.inlineTicks === ticks ? 0 : this.inlineTicks) : ticks;
        output += '`'.repeat(ticks); i += ticks; continue;
      }
      if (!this.fenced && !this.inlineTicks && input[i] === '<') {
        const tail = input.slice(i);
        if (OPEN.startsWith(tail.toLowerCase()) && !final) return { output, remainder: tail };
        if (tail.toLowerCase().startsWith(OPEN)) {
          const match = BLOCK.exec(tail);
          if (match && match.index === 0) {
            const quote = input[i - 1];
            const isQuotedExample = (quote === '"' || quote === "'") && input[i + match[0].length] === quote;
            if (isQuotedExample) {
              output += match[0];
              i += match[0].length;
              continue;
            }
            const [rawTarget, targetId] = String(match[1]).trim().split('#', 2);
            const target = rawTarget.toLowerCase();
            const body = String(match[3]).trim();
            const key = `${target}#${targetId || ''}::${body}`;
            if (body) {
              let cardMarker = this.dispatchedBodies.get(key);
              if (!cardMarker) {
                const messageId = crypto.randomUUID();
                cardMarker = marker({ id: messageId, to: target, targetId, body, status: 'sent' });
                this.dispatchedBodies.set(key, cardMarker);
                this.dispatchChannel(ctx, target, body, String(match[2]), targetId, messageId);
              }
              output += cardMarker;
            } else output += match[0];
            i += match[0].length;
            continue;
          }
          if (!final && !tail.includes('>') && tail.length <= MAX_HOLDBACK) return { output, remainder: tail };
        }
      }
      output += input[i++];
    }
    return { output, remainder: '' };
  }

  private dispatchChannel(ctx: StreamContext, targetChannel: string, body: string, attrs: string, targetId?: string, messageId = crypto.randomUUID()): void {
    try {
      const senderChannel = ctx.channel || (ctx.state as any)?.metadata?.wsChannel || 'unknown';
      const senderId = resolveAgentIdentity((ctx.state as any)?.metadata) || senderChannel;
      const metadata = (ctx.state as any)?.metadata || {};
      const senderJobId = String(metadata.delegatedJobId || metadata.jobId || '');
      const senderLabel = String(metadata.delegatedTaskLabel || metadata.agentLabel || metadata.agent?.name || senderId);
      const replyToThread: string = metadata.replyToThread || '';
      const fromThreadId: string = ctx.threadId || '';
      const ws = getWebSocketClientService();
      void ws.send(targetChannel, { type: 'agent_inbox_message', data: { receiverChannel: targetChannel, envelope: { from: senderId, kind: 'peer', body, senderChannel, senderThreadId: fromThreadId || undefined, senderJobId: senderJobId || undefined, senderLabel, targetId, replyToThreadId: !targetId && replyToThread ? replyToThread : undefined, ids: { messageId, threadId: fromThreadId || undefined, jobId: senderJobId || undefined } } } });
      const action = /\b(?:interrupt|wake)\b/i.test(attrs) ? 'inbox (legacy modifier ignored)' : 'inbox';
      console.log(`[ChannelTagExtractor] routed → channel="${ targetChannel }" from="${ senderChannel }" action=${ action } fromThread=${ fromThreadId.slice(-8) } chars=${ body.length }`);
    } catch (err) { console.warn('[ChannelTagExtractor] dispatch failed:', err); }
  }
}
