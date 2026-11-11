// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type AgentMailErrorCode =
  | 'token_missing'
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

  static tokenMissing(): AgentMailError {
    return new AgentMailError('token_missing', AgentMailError.TOKEN_MESSAGE);
  }
}
