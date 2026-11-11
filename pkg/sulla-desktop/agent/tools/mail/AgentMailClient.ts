// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailAddress } from './AgentMailAddress';
import { AgentMailError } from './AgentMailError';
import { AgentMailUntrustedContent, type AgentMailMessageDetail, type AgentMailMessageSummary } from './AgentMailUntrustedContent';

import type { AgentMailHttpRequest, AgentMailTransport } from './AgentMailTransport';
import type { ToolExecutionContext } from '../executionContext';

export interface AgentMailClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface AgentMailSendInput {
  from_local: string;
  to:         string;
  subject:    string;
  text?:      string;
  html?:      string;
}

class SystemAgentMailClock implements AgentMailClock {
  now(): number {
    return Date.now();
  }

  sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Agent mailbox API client (sulla-workers /agent-mail). Validates addresses
 * before any call, maps HTTP failures to clear errors, and wraps every piece
 * of mail content as untrusted third-party input.
 */
export class AgentMailClient {
  static readonly DEFAULT_WAIT_SECONDS = 120;
  static readonly MAX_WAIT_SECONDS = 300;
  /** The server holds one long-poll for at most 30 s. */
  static readonly SERVER_POLL_SECONDS = 30;
  /** wait_for_code with no `since` also accepts mail that landed just before the call. */
  static readonly DEFAULT_LOOKBACK_MS = 120_000;
  static readonly MAX_LIST_LIMIT = 100;
  private static readonly MIN_POLL_GAP_MS = 1_000;

  constructor(
    private readonly transport: AgentMailTransport,
    private readonly addresses = new AgentMailAddress(),
    private readonly content = new AgentMailUntrustedContent(),
    private readonly clock: AgentMailClock = new SystemAgentMailClock(),
  ) {}

  /** Clamp a caller timeout (seconds) to 1..300, default 120. */
  static waitSeconds(raw: unknown): number {
    const value = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(value)) return AgentMailClient.DEFAULT_WAIT_SECONDS;
    return Math.min(AgentMailClient.MAX_WAIT_SECONDS, Math.max(1, Math.round(value)));
  }

  async list(input: { to?: unknown; since?: unknown; limit?: unknown }, ctx?: ToolExecutionContext) {
    const to = input.to === undefined || input.to === null || input.to === '' ? undefined : this.addresses.mailbox(input.to);
    const limit = input.limit === undefined || input.limit === null || input.limit === ''
      ? undefined
      : Math.min(AgentMailClient.MAX_LIST_LIMIT, Math.max(1, Math.floor(Number(input.limit) || 1)));
    const body = await this.call({
      method: 'GET', path: '/agent-mail',
      query:  { to, since: this.since(input.since), limit: limit === undefined ? undefined : String(limit) },
    }, ctx) as { messages?: AgentMailMessageSummary[] };
    const messages = (body?.messages ?? []).map(message => this.content.summary(message));
    return this.content.envelope({ mailbox: to ?? null, count: messages.length, messages });
  }

  async read(id: unknown, ctx?: ToolExecutionContext) {
    const body = await this.call({ method: 'GET', path: `/agent-mail/${ this.id(id) }` }, ctx) as { message?: AgentMailMessageDetail };
    if (!body?.message) throw new AgentMailError('not_found', 'No agent mail message with that id');
    return this.content.envelope({ message: this.content.detail(body.message) });
  }

  async markRead(id: unknown, ctx?: ToolExecutionContext) {
    const body = await this.call({ method: 'POST', path: `/agent-mail/${ this.id(id) }/read` }, ctx) as { message?: AgentMailMessageSummary | null };
    return this.content.envelope({ marked: true, message: body?.message ? this.content.summary(body.message) : null });
  }

  /**
   * Wait for a one-time code to arrive at `to`. Repeats the server's 30 s
   * long-poll until a code arrives or the caller's timeout (default 120 s,
   * max 300 s) runs out.
   */
  async waitForCode(input: { to: unknown; since?: unknown; timeout?: unknown }, ctx?: ToolExecutionContext) {
    const to = this.addresses.mailbox(input.to);
    const timeoutSeconds = AgentMailClient.waitSeconds(input.timeout);
    const started = this.clock.now();
    const deadline = started + timeoutSeconds * 1000;
    const since = this.since(input.since) ?? String(Math.max(0, started - AgentMailClient.DEFAULT_LOOKBACK_MS));
    for (;;) {
      const remainingMs = deadline - this.clock.now();
      if (remainingMs <= 0) break;
      const pollSeconds = Math.min(AgentMailClient.SERVER_POLL_SECONDS, Math.ceil(remainingMs / 1000));
      const pollStarted = this.clock.now();
      const body = await this.call({
        method: 'GET', path: '/agent-mail/wait-for-code', query: { to, since, timeout: String(pollSeconds) },
      }, ctx) as { code?: string | null; candidates?: string[]; timedOut?: boolean; message?: AgentMailMessageSummary };
      if (body?.code) {
        return this.content.envelope({
          code:          String(body.code),
          candidates:    Array.isArray(body.candidates) ? body.candidates.map(String) : [String(body.code)],
          timedOut:      false,
          waitedSeconds: Math.round((this.clock.now() - started) / 1000),
          message:       body.message ? this.content.summary(body.message) : null,
        });
      }
      const elapsed = this.clock.now() - pollStarted;
      if (elapsed < AgentMailClient.MIN_POLL_GAP_MS && deadline - this.clock.now() > 0) {
        await this.clock.sleep(AgentMailClient.MIN_POLL_GAP_MS - elapsed);
      }
    }
    return this.content.envelope({ code: null, candidates: [], timedOut: true, waitedSeconds: timeoutSeconds, message: null });
  }

  /** Send from <from_local>@agents.sulladesktop.com. Needs POST /agent-mail/send on the server. */
  async send(input: AgentMailSendInput, ctx?: ToolExecutionContext) {
    const fromLocal = this.addresses.localPart(input.from_local);
    const to = this.addresses.recipient(input.to);
    const subject = String(input.subject ?? '').trim();
    if (!subject || /[\r\n]/.test(subject)) throw new AgentMailError('invalid_input', 'subject is required and must be one line');
    const text = typeof input.text === 'string' && input.text ? input.text : undefined;
    const html = typeof input.html === 'string' && input.html ? input.html : undefined;
    if (!text && !html) throw new AgentMailError('invalid_input', 'text or html body is required');
    const body = await this.call({
      method: 'POST', path: '/agent-mail/send', body: { from_local: fromLocal, to, subject, ...(text ? { text } : {}), ...(html ? { html } : {}) },
    }, ctx, true) as { ok?: boolean; error?: string; provider?: string; id?: string };
    if (body && body.ok === false) throw new AgentMailError('rejected', `Agent mail send was rejected: ${ this.content.safeError(body.error) }`);
    return { sent: true, from: `${ fromLocal }@${ AgentMailAddress.DOMAIN }`, to, subject, ...(body?.id ? { id: String(body.id) } : {}) };
  }

  private async call(request: AgentMailHttpRequest, ctx: ToolExecutionContext | undefined, isSend = false): Promise<unknown> {
    const response = await this.transport.request(request, ctx);
    if (response.status >= 200 && response.status < 300) return response.body;
    const reason = this.content.safeError((response.body as { error?: unknown } | null)?.error);
    if (response.status === 401 || response.status === 403) throw AgentMailError.tokenMissing();
    if (response.status === 404 && isSend) {
      throw new AgentMailError('server_unsupported', 'mail/send requires server support: the Sulla Cloud agent mail API has no POST /agent-mail/send endpoint yet.');
    }
    if (response.status === 404) throw new AgentMailError('not_found', 'No agent mail message with that id');
    if (response.status === 400 || response.status === 422) throw new AgentMailError('invalid_input', `Agent mail API rejected the request: ${ reason }`);
    if (response.status === 429) throw new AgentMailError('rejected', 'Agent mail API rate limit reached; retry shortly');
    throw new AgentMailError('server_error', `Agent mail API returned HTTP ${ response.status }`);
  }

  private id(raw: unknown): string {
    const id = String(raw ?? '').trim();
    if (!/^[A-Za-z0-9._~-]{1,200}$/.test(id)) throw new AgentMailError('invalid_input', 'id must be a message id from mail/list');
    return id;
  }

  /** ISO date or epoch milliseconds → epoch-ms string; undefined when absent. */
  private since(raw: unknown): string | undefined {
    if (raw === undefined || raw === null || raw === '') return undefined;
    const text = String(raw).trim();
    const value = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
    if (!Number.isFinite(value) || value < 0) throw new AgentMailError('invalid_input', 'since must be an ISO date or epoch milliseconds');
    return String(value);
  }
}
