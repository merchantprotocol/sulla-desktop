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
 * The signed-in user's one agent mailbox on the Sulla Cloud /agent-mailboxes
 * API. Each user has exactly one mailbox, found with GET /agent-mailboxes;
 * there is nothing to select. Auth is the user's Cloud session, injected by
 * the vault. Registration, disable and re-enable are dashboard-only.
 */
export class AgentMailboxClient extends AgentMailApiClient {
  /** The user's mailbox and whether agents can use it right now. Never throws for "none" or "disabled". */
  async mailbox(ctx?: ToolExecutionContext) {
    const mailbox = await this.fetchMailbox(ctx);
    if (!mailbox) return this.content.envelope({ mailbox: null, ready: false, message: AgentMailError.NO_MAILBOX_MESSAGE });
    const problem = this.unusable(mailbox);
    return this.content.envelope({ mailbox, ready: !problem, ...(problem ? { message: problem.message } : {}) });
  }

  async list(input: { since?: unknown; limit?: unknown }, ctx?: ToolExecutionContext) {
    const mailbox = await this.resolve(ctx);
    const body = await this.call({
      method: 'GET', path: this.path(mailbox, 'messages'), query: { since: this.since(input.since), limit: this.limit(input.limit) },
    }, ctx, 'mailbox') as { messages?: AgentMailMessageSummary[] };
    const messages = (body?.messages ?? []).map(message => this.content.summary(message));
    return this.content.envelope({ mailbox: mailbox.address, count: messages.length, messages });
  }

  async read(input: { id: unknown }, ctx?: ToolExecutionContext) {
    const id = this.id(input.id);
    const mailbox = await this.resolve(ctx);
    const body = await this.call({ method: 'GET', path: this.path(mailbox, 'messages', id) }, ctx, 'message') as { message?: AgentMailMessageDetail };
    if (!body?.message) throw new AgentMailError('not_found', 'No message with that id in your mailbox');
    return this.content.envelope({ mailbox: mailbox.address, message: this.content.detail(body.message) });
  }

  async markRead(input: { id: unknown }, ctx?: ToolExecutionContext) {
    const id = this.id(input.id);
    const mailbox = await this.resolve(ctx);
    const body = await this.call({ method: 'POST', path: this.path(mailbox, 'messages', id, 'read') }, ctx, 'message') as { message?: AgentMailMessageSummary | null };
    return this.content.envelope({ mailbox: mailbox.address, marked: true, message: body?.message ? this.content.summary(body.message) : null });
  }

  /** Wait for a one-time code (default 120 s, max 300 s, in ≤30 s server polls). */
  async waitForCode(input: { since?: unknown; timeout?: unknown }, ctx?: ToolExecutionContext) {
    const mailbox = await this.resolve(ctx);
    const result = await this.pollForCode(input, async(since, pollSeconds) => await this.call({
      method: 'GET', path: this.path(mailbox, 'wait-for-code'), query: { since, timeout: String(pollSeconds) },
    }, ctx, 'mailbox') as AgentMailCodePoll);
    return { ...result, mailbox: mailbox.address };
  }

  async send(input: { to: unknown; subject: unknown; text?: unknown; html?: unknown }, ctx?: ToolExecutionContext) {
    const message = this.outgoing(input);
    const mailbox = await this.resolve(ctx);
    const body = await this.call({ method: 'POST', path: this.path(mailbox, 'send'), body: message }, ctx, 'send') as { ok?: boolean; error?: string; id?: string };
    if (body && body.ok === false) throw new AgentMailError('rejected', `Send was rejected: ${ this.content.safeError(body.error) }`);
    return this.content.envelope({
      sent: true, from: mailbox.address, to: message.to, subject: message.subject, ...(body?.id ? { id: String(body.id) } : {}),
    });
  }

  /** The user's mailbox, or a clear error when there is none or it can't be used. */
  private async resolve(ctx: ToolExecutionContext | undefined): Promise<AgentMailbox> {
    const mailbox = await this.fetchMailbox(ctx);
    if (!mailbox) throw AgentMailError.noMailbox();
    const problem = this.unusable(mailbox);
    if (problem) throw problem;
    return mailbox;
  }

  private unusable(mailbox: AgentMailbox): AgentMailError | null {
    if (mailbox.status === 'active') return null;
    if (mailbox.status === 'disabled') return AgentMailError.mailboxDisabled(mailbox.address);
    return AgentMailError.mailboxNotReady(mailbox.address, mailbox.status);
  }

  /** GET /agent-mailboxes holds 0 or 1 entries: each user has one mailbox. */
  private async fetchMailbox(ctx: ToolExecutionContext | undefined): Promise<AgentMailbox | null> {
    const body = await this.call({ method: 'GET', path: '/agent-mailboxes' }, ctx, 'mailbox') as { mailboxes?: AgentMailbox[] };
    const first = Array.isArray(body?.mailboxes) ? body.mailboxes[0] : undefined;
    return first ? this.content.mailbox(first) : null;
  }

  private path(mailbox: AgentMailbox, ...segments: string[]): string {
    const id = this.id(mailbox.id, 'mailbox id', 'the mailbox id from Sulla Cloud');
    return ['/agent-mailboxes', id, ...segments.map(segment => encodeURIComponent(segment))].join('/');
  }

  private async call(request: AgentMailHttpRequest, ctx: ToolExecutionContext | undefined, target: Target): Promise<unknown> {
    const response = await this.transport.request(request, ctx);
    if (response.status >= 200 && response.status < 300) return response.body;
    const reason = this.content.safeError((response.body as { error?: unknown } | null)?.error);
    if (response.status === 401) throw AgentMailError.notSignedIn();
    if (response.status === 403) throw new AgentMailError('rejected', `Sulla Cloud refused this mailbox request: ${ reason }`);
    if (response.status === 404 && target === 'message') throw new AgentMailError('not_found', 'No message with that id in your mailbox');
    if (response.status === 404) throw AgentMailError.mailboxNotFound();
    if (response.status === 400 || response.status === 422) throw new AgentMailError('invalid_input', `Sulla Cloud rejected the request: ${ reason }`);
    if (response.status === 429) throw new AgentMailError('rejected', target === 'send' ? 'Mailbox send limit reached; retry later' : 'Sulla Cloud rate limit reached; retry shortly');
    if (response.status === 502 && target === 'send') throw new AgentMailError('server_error', 'The mail provider reported a send failure (HTTP 502); check mail/list or the dashboard before retrying');
    throw new AgentMailError('server_error', `Sulla Cloud returned HTTP ${ response.status }`);
  }
}
