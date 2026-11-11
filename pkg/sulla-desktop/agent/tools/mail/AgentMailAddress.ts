// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { AgentMailError } from './AgentMailError';

/**
 * Rules for agent mailbox addresses (<local>@agents.sulladesktop.com). Mirrors
 * the server's AgentMailPolicy so a bad address fails here, before any network
 * call, with a message the agent can act on.
 */
export class AgentMailAddress {
  static readonly DOMAIN = 'agents.sulladesktop.com';
  /** Lowercase letters, digits and . _ + -; starts and ends alphanumeric; max 64. */
  private static readonly LOCAL_PART = /^[a-z0-9](?:[a-z0-9._+-]{0,62}[a-z0-9])?$/;
  private static readonly EXTERNAL = /^[^\s@<>()",;:\\[\]]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

  constructor(private readonly domain = AgentMailAddress.DOMAIN) {}

  /**
   * A mailbox the agent owns: either a bare local-part or a full address on the
   * agent mail domain. Returns the normalized full address.
   */
  mailbox(value: unknown, field = 'to'): string {
    const normalized = String(value ?? '').trim().toLowerCase();
    const at = normalized.lastIndexOf('@');
    const local = at === -1 ? normalized : normalized.slice(0, at);
    if (at !== -1 && normalized.slice(at + 1) !== this.domain) {
      throw new AgentMailError('invalid_address', `${ field } must be an address ending in @${ this.domain }`);
    }
    if (!AgentMailAddress.LOCAL_PART.test(local) || local.includes('..')) {
      throw new AgentMailError('invalid_address', `${ field } must be a mailbox like <name>@${ this.domain } (lowercase letters, digits, . _ + -)`);
    }
    return `${ local }@${ this.domain }`;
  }

  /** The local-part of a mailbox the agent owns. */
  localPart(value: unknown, field = 'from_local'): string {
    return this.mailbox(value, field).split('@')[0];
  }

  /** An outside recipient for mail/send. */
  recipient(value: unknown): string {
    const address = String(value ?? '').trim();
    if (!AgentMailAddress.EXTERNAL.test(address) || address.length > 320) {
      throw new AgentMailError('invalid_address', 'to must be a single valid email address');
    }
    return address;
  }
}
