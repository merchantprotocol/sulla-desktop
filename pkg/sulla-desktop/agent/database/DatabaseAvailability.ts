// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Tells "PostgreSQL is not reachable right now" apart from every other
 * database failure.
 *
 * Postgres runs inside the Sulla VM. While the VM boots, restarts or stops,
 * every query fails with one of a small set of connection-level errors
 * (SQLSTATE 57P03 "the database system is starting up / shutting down",
 * ECONNREFUSED on the host port, pg-pool's connect timeout, or
 * "Connection terminated unexpectedly" for sockets that were open). Those
 * are expected and temporary. Anything else (a bad query, a constraint
 * violation, a missing table) is a real failure and must still surface.
 */
export class DatabaseUnavailableClassifier {
  /** Postgres SQLSTATEs that mean the server cannot take work right now. */
  private static readonly SQLSTATES = new Set([
    '57P01', // admin_shutdown: terminating connection due to administrator command
    '57P02', // crash_shutdown
    '57P03', // cannot_connect_now: starting up / shutting down / in recovery
    '08000', // connection_exception
    '08001', // sqlclient_unable_to_establish_sqlconnection
    '08003', // connection_does_not_exist
    '08004', // sqlserver_rejected_establishment_of_sqlconnection
    '08006', // connection_failure
  ]);

  /** Node socket errors raised when the database port is not answering. */
  private static readonly SOCKET_CODES = new Set([
    'ECONNREFUSED',
    'ECONNRESET',
    'EPIPE',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
  ]);

  /** Messages node-postgres and PostgresClient raise without a code. */
  private static readonly MESSAGES = [
    /^Connection terminated/i,
    /timeout exceeded when trying to connect/i,
    /PostgreSQL is shutting down/i,
    /the database system is (starting up|shutting down|in recovery mode|not yet accepting connections)/i,
  ];

  /**
   * @param databasePort When set, a socket error that names a different port
   *   (for example a cloud request refused on 443) is not treated as the
   *   database being down.
   */
  constructor(private readonly databasePort?: number) {}

  isUnavailable(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;

    // net.connect to "localhost" can try several addresses and reject with
    // an AggregateError whose children carry the real codes.
    const children = (error as { errors?: unknown }).errors;
    if (Array.isArray(children) && children.length > 0 && children.every(child => this.isUnavailable(child))) {
      return true;
    }

    const { code, port, message } = error as { code?: unknown; port?: unknown; message?: unknown };

    if (typeof code === 'string') {
      if (DatabaseUnavailableClassifier.SQLSTATES.has(code)) return true;
      if (DatabaseUnavailableClassifier.SOCKET_CODES.has(code)) {
        return this.databasePort === undefined || typeof port !== 'number' || port === this.databasePort;
      }
    }

    return typeof message === 'string' && DatabaseUnavailableClassifier.MESSAGES.some(pattern => pattern.test(message));
  }
}

/**
 * Remembers whether the database is currently down so a caller logs one line
 * when an outage starts and one when it ends, instead of one per failed call.
 */
export class DatabaseOutageState {
  private unavailableSince: number | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  get isDown(): boolean {
    return this.unavailableSince !== null;
  }

  /** Records a failure. Returns true only for the first failure of an outage. */
  markUnavailable(): boolean {
    if (this.unavailableSince !== null) return false;
    this.unavailableSince = this.now();

    return true;
  }

  /**
   * Records a success. Returns how long the outage lasted in ms when this
   * success ends one, or null when the database was already up.
   */
  markAvailable(): number | null {
    if (this.unavailableSince === null) return null;
    const downForMs = this.now() - this.unavailableSince;
    this.unavailableSince = null;

    return downForMs;
  }
}
