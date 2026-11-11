// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailApiClient, type AgentMailCodePoll } from './AgentMailApiClient';
import { AgentMailError } from './AgentMailError';

import type { AgentMailHttpRequest } from './AgentMailTransport';
import type { AgentMailbox, AgentMailMessageDetail, AgentMailMessageSummary } from './AgentMailUntrustedContent';
import type { ToolExecutionContext } from '../executionContext';

type Target = 'mailbox' | 'message' | 'send';

/**
 * The signed-in user's own mailboxes on the Sulla Cloud /agent-mailboxes API.
 * Auth is the user's Cloud session, injected by the vault; a mailbox is
 * picked by address, local part or id, and defaults to the user's only
 * active mailbox. Registration and disable are dashboard-only.
 */
export class AgentMailboxClient extends AgentMailApiClient {
  async mailboxes(ctx?: ToolExecutionContext) {
    const mailboxes = await this.fetchMailboxes(ctx);
    const active = mailboxes.filter(mailbox => mailbox.status === 'active');
    return this.content.envelope({
      count:          mailboxes.length,
      defaultMailbox: active.length === 1 ? active[0].address : null,
      mailboxes,
      ...(mailboxes.length ? {} : { hint: AgentMailError.NO_MAILBOX_MESSAGE }),
    });
  }

  async list(input: { mailbox?: unknown; since?: unknown; limit?: unknown }, ctx?: ToolExecutionContext) {
    const mailbox = await this.resolve(input.mailbox, ctx);
    const body = await this.call({
      method: 'GET', path: this.path(mailbox, 'messages'), query: { since: this.since(input.since), limit: this.limit(input.limit) },
    }, ctx, 'mailbox') as { messages?: AgentMailMessageSummary[] };
    const messages = (body?.messages ?? []).map(message => this.content.summary(message));
    return this.content.envelope({ mailbox: mailbox.address, count: messages.length, messages });
  }

  async read(input: { mailbox?: unknown; id: unknown }, ctx?: ToolExecutionContext) {
    const id = this.id(input.id);
    const mailbox = await this.resolve(input.mailbox, ctx);
    const body = await this.call({ method: 'GET', path: this.path(mailbox, 'messages', id) }, ctx, 'message') as { message?: AgentMailMessageDetail };
    if (!body?.message) throw new AgentMailError('not_found', 'No message with that id in this mailbox');
    return this.content.envelope({ mailbox: mailbox.address, message: this.content.detail(body.message) });
  }

  async markRead(input: { mailbox?: unknown; id: unknown }, ctx?: ToolExecutionContext) {
    const id = this.id(input.id);
    const mailbox = await this.resolve(input.mailbox, ctx);
    const body = await this.call({ method: 'POST', path: this.path(mailbox, 'messages', id, 'read') }, ctx, 'message') as { message?: AgentMailMessageSummary | null };
    return this.content.envelope({ mailbox: mailbox.address, marked: true, message: body?.message ? this.content.summary(body.message) : null });
  }

  /** Wait for a one-time code (default 120 s, max 300 s, in ≤30 s server polls). */
  async waitForCode(input: { mailbox?: unknown; since?: unknown; timeout?: unknown }, ctx?: ToolExecutionContext) {
    const mailbox = await this.resolve(input.mailbox, ctx);
    const result = await this.pollForCode(input, async(since, pollSeconds) => await this.call({
      method: 'GET', path: this.path(mailbox, 'wait-for-code'), query: { since, timeout: String(pollSeconds) },
    }, ctx, 'mailbox') as AgentMailCodePoll);
    return { ...result, mailbox: mailbox.address };
  }

  async send(input: { mailbox?: unknown; to: unknown; subject: unknown; text?: unknown; html?: unknown }, ctx?: ToolExecutionContext) {
    const message = this.outgoing(input);
    const mailbox = await this.resolve(input.mailbox, ctx);
    const body = await this.call({ method: 'POST', path: this.path(mailbox, 'send'), body: message }, ctx, 'send') as { ok?: boolean; error?: string; id?: string };
    if (body && body.ok === false) throw new AgentMailError('rejected', `Send was rejected: ${ this.content.safeError(body.error) }`);
    return this.content.envelope({
      sent: true, from: mailbox.address, to: message.to, subject: message.subject, ...(body?.id ? { id: String(body.id) } : {}),
    });
  }

  /** The named mailbox, or the user's only active one when none is named. */
  private async resolve(raw: unknown, ctx: ToolExecutionContext | undefined): Promise<AgentMailbox> {
    const wanted = raw === undefined || raw === null ? '' : String(raw).trim();
    // An address must be on the agent domain; checked before any network call.
    const address = wanted.includes('@') ? this.addresses.mailbox(wanted, 'mailbox') : null;
    const mailboxes = await this.fetchMailboxes(ctx);
    if (wanted) {
      const lower = wanted.toLowerCase();
      const match = mailboxes.find(mailbox => address
        ? mailbox.address === address
        : mailbox.id === wanted || mailbox.localPart === lower);
      if (!match) throw AgentMailError.mailboxNotFound(mailboxes.map(mailbox => mailbox.address));
      return match;
    }
    const active = mailboxes.filter(mailbox => mailbox.status === 'active');
    if (active.length === 1) return active[0];
    if (!active.length) throw AgentMailError.noMailbox();
    throw new AgentMailError('invalid_input', `You have ${ active.length } active mailboxes; pass mailbox as one of: ${ active.map(mailbox => mailbox.address).join(', ') }`);
  }

  private async fetchMailboxes(ctx: ToolExecutionContext | undefined): Promise<AgentMailbox[]> {
    const body = await this.call({ method: 'GET', path: '/agent-mailboxes' }, ctx, 'mailbox') as { mailboxes?: AgentMailbox[] };
    return (Array.isArray(body?.mailboxes) ? body.mailboxes : []).map(mailbox => this.content.mailbox(mailbox));
  }

  private path(mailbox: AgentMailbox, ...segments: string[]): string {
    const id = this.id(mailbox.id, 'mailbox id', 'a mailbox id from mail/mailboxes');
    return ['/agent-mailboxes', id, ...segments.map(segment => encodeURIComponent(segment))].join('/');
  }

  private async call(request: AgentMailHttpRequest, ctx: ToolExecutionContext | undefined, target: Target): Promise<unknown> {
    const response = await this.transport.request(request, ctx);
    if (response.status >= 200 && response.status < 300) return response.body;
    const reason = this.content.safeError((response.body as { error?: unknown } | null)?.error);
    if (response.status === 401) throw AgentMailError.notSignedIn();
    if (response.status === 403) throw new AgentMailError('rejected', `Sulla Cloud refused this mailbox request: ${ reason }`);
    if (response.status === 404 && target === 'message') throw new AgentMailError('not_found', 'No message with that id in this mailbox');
    if (response.status === 404) throw AgentMailError.mailboxNotFound([]);
    if (response.status === 400 || response.status === 422) throw new AgentMailError('invalid_input', `Sulla Cloud rejected the request: ${ reason }`);
    if (response.status === 429) throw new AgentMailError('rejected', target === 'send' ? 'Mailbox send limit reached; retry later' : 'Sulla Cloud rate limit reached; retry shortly');
    if (response.status === 502 && target === 'send') throw new AgentMailError('server_error', 'The mail provider reported a send failure (HTTP 502); check mail/list or the dashboard before retrying');
    throw new AgentMailError('server_error', `Sulla Cloud returned HTTP ${ response.status }`);
  }
}
