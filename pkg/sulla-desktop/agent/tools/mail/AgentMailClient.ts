// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailApiClient, type AgentMailCodePoll } from './AgentMailApiClient';
import { AgentMailAddress } from './AgentMailAddress';
import { AgentMailError } from './AgentMailError';

import type { AgentMailHttpRequest } from './AgentMailTransport';
import type { AgentMailMessageDetail, AgentMailMessageSummary } from './AgentMailUntrustedContent';
import type { ToolExecutionContext } from '../executionContext';

export type { AgentMailClock } from './AgentMailApiClient';

export interface AgentMailSendInput {
  from_local: string;
  to:         string;
  subject:    string;
  text?:      string;
  html?:      string;
}

/**
 * Internal service mailboxes (sulla@, qa@, e2e@) on the global-token
 * /agent-mail API. Used only when the sulla_agent_mail vault account exists;
 * every user mailbox goes through AgentMailboxClient on the Cloud session.
 */
export class AgentMailClient extends AgentMailApiClient {
  async list(input: { to?: unknown; since?: unknown; limit?: unknown }, ctx?: ToolExecutionContext) {
    const to = input.to === undefined || input.to === null || input.to === '' ? undefined : this.addresses.mailbox(input.to);
    const body = await this.call({
      method: 'GET', path: '/agent-mail',
      query:  { to, since: this.since(input.since), limit: this.limit(input.limit) },
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

  /** Wait for a one-time code to arrive at `to` (default 120 s, max 300 s). */
  async waitForCode(input: { to: unknown; since?: unknown; timeout?: unknown }, ctx?: ToolExecutionContext) {
    const to = this.addresses.mailbox(input.to);
    return this.pollForCode(input, async(since, pollSeconds) => await this.call({
      method: 'GET', path: '/agent-mail/wait-for-code', query: { to, since, timeout: String(pollSeconds) },
    }, ctx) as AgentMailCodePoll);
  }

  /** Send from <from_local>@agents.sulladesktop.com. */
  async send(input: AgentMailSendInput, ctx?: ToolExecutionContext) {
    const fromLocal = this.addresses.localPart(input.from_local);
    const message = this.outgoing(input);
    const body = await this.call({ method: 'POST', path: '/agent-mail/send', body: { from_local: fromLocal, ...message } }, ctx, true) as { ok?: boolean; error?: string; id?: string };
    if (body && body.ok === false) throw new AgentMailError('rejected', `Agent mail send was rejected: ${ this.content.safeError(body.error) }`);
    return this.content.envelope({
      sent: true, from: `${ fromLocal }@${ AgentMailAddress.DOMAIN }`, to: message.to, subject: message.subject, ...(body?.id ? { id: String(body.id) } : {}),
    });
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
}
