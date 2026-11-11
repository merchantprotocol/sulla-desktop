// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { BaseTool, type ToolResponse } from '../base';
import { AgentMailClientFactory } from './AgentMailClientFactory';
import { AgentMailError } from './AgentMailError';

import type { AgentMailService } from './AgentMailRouter';

export interface AgentMailClientSource {
  create(): Promise<AgentMailService>;
}

/**
 * Shared shell for the mail/* tools: builds the mail service, runs one action and
 * returns its JSON. Errors carry only the AgentMailError message, never a
 * token or a raw server/vault error.
 */
export abstract class AgentMailTool extends BaseTool {
  name = '';
  description = '';

  constructor(private readonly clients: AgentMailClientSource = new AgentMailClientFactory()) {
    super();
  }

  protected abstract run(mail: AgentMailService, input: Record<string, unknown>): Promise<Record<string, unknown>>;

  protected async _validatedCall(input: Record<string, unknown>): Promise<ToolResponse> {
    try {
      const result = await this.run(await this.clients.create(), input);
      return { successBoolean: true, responseString: JSON.stringify(result, null, 2), result };
    } catch (error) {
      const message = error instanceof AgentMailError ? error.message : 'Agent mail request failed';
      const code = error instanceof AgentMailError ? error.code : 'server_error';
      return { successBoolean: false, responseString: `mail/${ this.name || 'tool' } failed: ${ message }`, result: { error: code, message } };
    }
  }
}
