// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type AgentMailErrorCode =
  | 'token_missing'
  | 'not_signed_in'
  | 'no_mailbox'
  | 'mailbox_not_found'
  | 'mailbox_disabled'
  | 'mailbox_not_ready'
  | 'service_mailbox_only'
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

  static readonly NOT_SIGNED_IN_MESSAGE = 'Not signed in to Sulla Cloud. Agent mail uses your Sulla Cloud session: ask your human to sign in to Sulla Cloud in Sulla Desktop, then retry.';
  static readonly NO_MAILBOX_MESSAGE = 'No agent email yet. Register your agent email in the Sulla Cloud dashboard Mail area (https://sulladesktop.com/cloud/), then retry.';
  static readonly SERVICE_MAILBOX_MESSAGE = 'mailbox is only for the internal service mailboxes (sulla, qa, e2e) and needs the sulla_agent_mail vault account. Omit mailbox to use your own agent email.';

  static tokenMissing(): AgentMailError {
    return new AgentMailError('token_missing', AgentMailError.TOKEN_MESSAGE);
  }

  static notSignedIn(): AgentMailError {
    return new AgentMailError('not_signed_in', AgentMailError.NOT_SIGNED_IN_MESSAGE);
  }

  static noMailbox(): AgentMailError {
    return new AgentMailError('no_mailbox', AgentMailError.NO_MAILBOX_MESSAGE);
  }

  static mailboxDisabled(address: string): AgentMailError {
    return new AgentMailError('mailbox_disabled', `Your agent email ${ address } is disabled. Re-enable it in the Sulla Cloud dashboard Mail area (https://sulladesktop.com/cloud/), then retry.`);
  }

  static mailboxNotReady(address: string, status: string): AgentMailError {
    return status === 'error'
      ? new AgentMailError('mailbox_not_ready', `Setting up your agent email ${ address } failed. Retry it in the Sulla Cloud dashboard Mail area (https://sulladesktop.com/cloud/).`)
      : new AgentMailError('mailbox_not_ready', `Your agent email ${ address } is still being set up (${ status }). Retry in a minute.`);
  }

  static mailboxNotFound(): AgentMailError {
    return new AgentMailError('mailbox_not_found', 'Your agent email was not found on Sulla Cloud. Check it with mail/mailbox.');
  }

  static serviceMailboxOnly(): AgentMailError {
    return new AgentMailError('service_mailbox_only', AgentMailError.SERVICE_MAILBOX_MESSAGE);
  }
}
