// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Runs a command in the Sulla runtime guest as root. */
export interface GuestCommandRunner {
  /** Returns the command's stdout. */
  capture(args: string[]): Promise<string>;
  run(args: string[]): Promise<void>;
}

/**
 * The Accounts service database inside the guest PostgreSQL container. psql and
 * createdb run over the container's local socket, before Desktop's own database
 * client is available.
 */
export class SullaAccountsDatabaseRepository {
  static readonly DATABASE = 'sulla_accounts';
  static readonly EXISTS_QUERY = "SELECT 1 FROM pg_database WHERE datname='sulla_accounts'";

  constructor(
    private readonly guest: GuestCommandRunner,
    private readonly container = 'sulla_postgres',
  ) {}

  async exists(): Promise<boolean> {
    const output = await this.guest.capture([
      'docker', 'exec', this.container, 'psql', '-U', 'sulla', '-d', 'postgres', '-tAc', SullaAccountsDatabaseRepository.EXISTS_QUERY,
    ]);

    return output.trim() === '1';
  }

  /** Creates the database when it is missing. Throws when psql or createdb fails. */
  async ensureExists(): Promise<void> {
    if (await this.exists()) return;
    await this.guest.run([
      'docker', 'exec', this.container, 'createdb', '-U', 'sulla', '--encoding=UTF8', '--template=template0', SullaAccountsDatabaseRepository.DATABASE,
    ]);
  }
}
