// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailAddress } from './AgentMailAddress';
import { AgentMailError } from './AgentMailError';
import { AgentMailLaneSelector } from './AgentMailLaneSelector';
import { AGENT_MAIL_INTEGRATION_ID } from './AgentMailTransport';

import type { AgentMailboxClient } from './AgentMailboxClient';
import type { AgentMailClient } from './AgentMailClient';
import type { ToolExecutionContext } from '../executionContext';

export type AgentMailInput = Record<string, unknown>;

/** What the mail/* tools call. */
export interface AgentMailService {
  mailbox(ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  list(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  read(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  markRead(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  waitForCode(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  send(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
}

/**
 * Sends each mail call to the right lane. With no `mailbox`, the call uses
 * the user's one agent email on their Sulla Cloud session. `mailbox` is
 * accepted only for the internal service mailboxes (sulla@, qa@, e2e@), and
 * only when the sulla_agent_mail token account exists.
 */
export class AgentMailRouter implements AgentMailService {
  constructor(
    private readonly user: AgentMailboxClient,
    private readonly service: AgentMailClient | null,
    private readonly lanes: AgentMailLaneSelector = new AgentMailLaneSelector(async() => service !== null),
  ) {}

  async mailbox(ctx?: ToolExecutionContext) {
    const result = await this.user.mailbox(ctx);
    if (!this.service) return result;
    return { ...result, serviceMailboxes: AgentMailLaneSelector.SERVICE_LOCAL_PARTS.map(local => `${ local }@${ AgentMailAddress.DOMAIN }`) };
  }

  async list(input: AgentMailInput, ctx?: ToolExecutionContext) {
    const { since, limit } = input;
    const service = await this.serviceMailbox('list', input);
    return service ? this.service!.list({ to: service, since, limit }, ctx) : this.user.list({ since, limit }, ctx);
  }

  async read(input: AgentMailInput, ctx?: ToolExecutionContext) {
    return await this.serviceMailbox('read', input) ? this.service!.read(input.id, ctx) : this.user.read({ id: input.id }, ctx);
  }

  async markRead(input: AgentMailInput, ctx?: ToolExecutionContext) {
    return await this.serviceMailbox('mark_read', input) ? this.service!.markRead(input.id, ctx) : this.user.markRead({ id: input.id }, ctx);
  }

  async waitForCode(input: AgentMailInput, ctx?: ToolExecutionContext) {
    const { since, timeout } = input;
    const service = await this.serviceMailbox('wait_for_code', input);
    return service ? this.service!.waitForCode({ to: service, since, timeout }, ctx) : this.user.waitForCode({ since, timeout }, ctx);
  }

  async send(input: AgentMailInput, ctx?: ToolExecutionContext) {
    const message = { to: input.to, subject: input.subject, text: input.text, html: input.html };
    const service = await this.serviceMailbox('send', input);
    if (!service) return this.user.send(message, ctx);
    return this.service!.send({
      from_local: String(service), to: String(message.to ?? ''), subject: String(message.subject ?? ''),
      text: typeof message.text === 'string' ? message.text : undefined, html: typeof message.html === 'string' ? message.html : undefined,
    }, ctx);
  }

  /**
   * The service mailbox this call names, or undefined for the user's own
   * mailbox. Any other mailbox value is refused before a network call.
   */
  private async serviceMailbox(endpoint: string, input: AgentMailInput): Promise<unknown> {
    const named = AgentMailLaneSelector.mailboxArg(endpoint, input);
    if (named === undefined || named === null || named === '') return undefined;
    if (this.service !== null && await this.lanes.lane(endpoint, input) === AGENT_MAIL_INTEGRATION_ID) return named;
    throw AgentMailError.serviceMailboxOnly();
  }
}
