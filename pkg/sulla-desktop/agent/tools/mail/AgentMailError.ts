// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type AgentMailErrorCode =
  | 'token_missing'
  | 'not_signed_in'
  | 'no_mailbox'
  | 'mailbox_not_found'
  | 'invalid_address'
  | 'invalid_input'
  | 'not_found'
  | 'server_unsupported'
  | 'rejected'
  | 'server_error';

/** A mail tool failure with a message that is safe to show the agent (never a token). */
export class AgentMailError extends Error {
  static readonly TOKEN_MESSAGE = 'Agent mail token missing or invalid. Store the AGENT_MAIL_TOKEN in the Sulla vault as account type "sulla_agent_mail", property "token" (sulla vault/vault_set_credential).';

  constructor(readonly code: AgentMailErrorCode, message: string) {
    super(message);
    this.name = 'AgentMailError';
  }

  static readonly NOT_SIGNED_IN_MESSAGE = 'Not signed in to Sulla Cloud. Agent mailboxes use your Sulla Cloud session: ask your human to sign in to Sulla Cloud in Sulla Desktop, then retry.';
  static readonly NO_MAILBOX_MESSAGE = 'You have no active agent mailbox. Ask your human to register one in the Sulla Cloud dashboard, in the Mail area (https://sulladesktop.com/cloud/), then retry.';

  static tokenMissing(): AgentMailError {
    return new AgentMailError('token_missing', AgentMailError.TOKEN_MESSAGE);
  }

  static notSignedIn(): AgentMailError {
    return new AgentMailError('not_signed_in', AgentMailError.NOT_SIGNED_IN_MESSAGE);
  }

  static noMailbox(): AgentMailError {
    return new AgentMailError('no_mailbox', AgentMailError.NO_MAILBOX_MESSAGE);
  }

  /** `known` lists the caller's own addresses so the agent can pick a real one. */
  static mailboxNotFound(known: string[]): AgentMailError {
    const choices = known.length ? ` Your mailboxes: ${ known.join(', ') }.` : ' You have no mailboxes yet; ask your human to register one in the Sulla Cloud dashboard Mail area.';
    return new AgentMailError('mailbox_not_found', `No agent mailbox with that address or id.${ choices } Run mail/mailboxes to list them.`);
  }
}
