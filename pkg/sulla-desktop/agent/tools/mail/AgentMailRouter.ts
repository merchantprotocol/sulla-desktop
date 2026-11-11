// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailAddress } from './AgentMailAddress';
import { AgentMailLaneSelector } from './AgentMailLaneSelector';
import { AGENT_MAIL_INTEGRATION_ID } from './AgentMailTransport';

import type { AgentMailboxClient } from './AgentMailboxClient';
import type { AgentMailClient } from './AgentMailClient';
import type { ToolExecutionContext } from '../executionContext';

export type AgentMailInput = Record<string, unknown>;

/** What the mail/* tools call. */
export interface AgentMailService {
  mailboxes(ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  list(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  read(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  markRead(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  waitForCode(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
  send(input: AgentMailInput, ctx?: ToolExecutionContext): Promise<Record<string, unknown>>;
}

/**
 * Sends each mail call to the right lane: the user's own mailboxes on their
 * Sulla Cloud session, or, for sulla@/qa@/e2e@ only and only when the
 * service token account exists, the internal /agent-mail lane.
 */
export class AgentMailRouter implements AgentMailService {
  constructor(
    private readonly user: AgentMailboxClient,
    private readonly service: AgentMailClient | null,
    private readonly lanes: AgentMailLaneSelector = new AgentMailLaneSelector(async() => service !== null),
  ) {}

  async mailboxes(ctx?: ToolExecutionContext) {
    const result = await this.user.mailboxes(ctx);
    if (!this.service) return result;
    return { ...result, serviceMailboxes: AgentMailLaneSelector.SERVICE_LOCAL_PARTS.map(local => `${ local }@${ AgentMailAddress.DOMAIN }`) };
  }

  async list(input: AgentMailInput, ctx?: ToolExecutionContext) {
    const mailbox = AgentMailLaneSelector.mailboxArg('list', input);
    const { since, limit } = input;
    return await this.serviceLane('list', input) ? this.service!.list({ to: mailbox, since, limit }, ctx) : this.user.list({ mailbox, since, limit }, ctx);
  }

  async read(input: AgentMailInput, ctx?: ToolExecutionContext) {
    return await this.serviceLane('read', input) ? this.service!.read(input.id, ctx) : this.user.read({ mailbox: input.mailbox, id: input.id }, ctx);
  }

  async markRead(input: AgentMailInput, ctx?: ToolExecutionContext) {
    return await this.serviceLane('mark_read', input) ? this.service!.markRead(input.id, ctx) : this.user.markRead({ mailbox: input.mailbox, id: input.id }, ctx);
  }

  async waitForCode(input: AgentMailInput, ctx?: ToolExecutionContext) {
    const mailbox = AgentMailLaneSelector.mailboxArg('wait_for_code', input);
    const { since, timeout } = input;
    return await this.serviceLane('wait_for_code', input) ? this.service!.waitForCode({ to: mailbox, since, timeout }, ctx) : this.user.waitForCode({ mailbox, since, timeout }, ctx);
  }

  async send(input: AgentMailInput, ctx?: ToolExecutionContext) {
    const mailbox = AgentMailLaneSelector.mailboxArg('send', input);
    const message = { to: input.to, subject: input.subject, text: input.text, html: input.html };
    if (await this.serviceLane('send', input)) {
      return this.service!.send({
        from_local: String(mailbox ?? ''), to: String(message.to ?? ''), subject: String(message.subject ?? ''),
        text: typeof message.text === 'string' ? message.text : undefined, html: typeof message.html === 'string' ? message.html : undefined,
      }, ctx);
    }
    return this.user.send({ mailbox, ...message }, ctx);
  }

  private async serviceLane(endpoint: string, input: AgentMailInput): Promise<boolean> {
    return this.service !== null && await this.lanes.lane(endpoint, input) === AGENT_MAIL_INTEGRATION_ID;
  }
}
