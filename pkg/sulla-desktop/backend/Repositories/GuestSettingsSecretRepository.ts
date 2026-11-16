// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { DockerCli } from '../sullaComposeContainers';

/**
 * Reads the stored service secret straight from the guest's settings table,
 * with psql over the PostgreSQL container's local socket (no password). Used
 * before Desktop's own database client can connect, because that client needs
 * this very secret. The Docker runner must not log stdout: it carries the secret.
 */
export class GuestSettingsSecretRepository {
  static readonly QUERY = "SELECT value FROM sulla_settings WHERE property = 'sullaServicePassword'";

  constructor(
    /** Must not log command output. */
    private readonly quietDocker: DockerCli,
    private readonly container = 'sulla_postgres',
  ) {}

  /** The stored value byte for byte; null when there is no row or it is empty. Throws when psql fails. */
  async read(): Promise<string | null> {
    const output = await this.quietDocker.run([
      'exec', this.container, 'psql', '-U', 'sulla', '-d', 'sulla', '-v', 'ON_ERROR_STOP=1', '-tAc', GuestSettingsSecretRepository.QUERY,
    ]);
    const value = output.replace(/\r?\n$/, '');

    return value.length > 0 ? value : null;
  }
}
