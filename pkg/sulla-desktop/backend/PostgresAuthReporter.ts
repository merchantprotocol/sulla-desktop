// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PostgresAuthLogger, PostgresAuthState, PostgresAuthTrustReason } from './PostgresAuthTypes';

/**
 * Turns PostgreSQL auth states and errors into `[PostgresAuth]` log lines.
 * Error text is cut to its first line and the secret is masked out of it.
 */
export class PostgresAuthReporter {
  private static readonly REASON_TEXT: Record<PostgresAuthTrustReason, string> = {
    'legacy-development-secret': 'legacy development secret; rotation pending',
    'unsupported-secret':        'service secret cannot be turned into a SCRAM verifier',
    'role-password-not-set':     'role password could not be set',
    'consumer-drift':            'a database consumer still runs an outdated configuration',
    'accounts-stale':            'accounts has not picked up the current database password',
    'probe-failed':              'the service secret did not log in over TCP',
    'hba-rule-errors':           'the managed hba file has rule errors',
    'switch-failed':             'the hba switch did not complete',
    'rolled-back':               'rolled back after verification failed',
    unavailable:                 'PostgreSQL could not be inspected',
  };

  constructor(private readonly logger: PostgresAuthLogger) {}

  reasonText(reason: PostgresAuthTrustReason): string {
    return PostgresAuthReporter.REASON_TEXT[reason];
  }

  /** Logs the `[PostgresAuth] state=…` line and returns the state unchanged. */
  report(state: PostgresAuthState): PostgresAuthState {
    if (state.kind === 'scram') {
      const note = state.unverified
        ? ' (unverified: the TCP login probe did not complete)'
        : state.changed ? ' (switched from trust)' : '';

      (state.unverified ? this.logger.warn : this.logger.log).call(this.logger, `[PostgresAuth] state=scram${ note }`);
    } else {
      const detail = state.detail ? `: ${ state.detail }` : '';
      const line = `[PostgresAuth] state=trust (${ this.reasonText(state.reason) }${ detail })`;

      if (state.reason === 'legacy-development-secret') {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    }

    return state;
  }

  /** An error's first line with the secret masked out (defence in depth; no caller should carry it). */
  describe(error: unknown, secret: string): string {
    const text = (error instanceof Error ? error.message : String(error)).split('\n')[0];

    return secret ? text.split(secret).join('[redacted]') : text;
  }
}
