// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type { PostgresAuthReporter } from './PostgresAuthReporter';
import type { PostgresAuthLogger, PostgresAuthRepository } from './PostgresAuthTypes';

/**
 * The managed hba file's content, and putting trust back: the pre-switch
 * backup when there is an unmanaged one, else a trust file when the current
 * file is managed, else the (unmanaged) file is left as it is.
 */
export class PostgresHbaRestore {
  static readonly MANAGED_HEADER = '# managed-by: sulla-desktop postgres-auth v1';
  static readonly MANAGED_HBA = `${ PostgresHbaRestore.MANAGED_HEADER }\nlocal all all trust\nhost all all all scram-sha-256\n`;
  /** Written by a restore when no unmanaged backup exists. */
  static readonly TRUST_HBA = 'local all all trust\nhost all all all trust\n';

  constructor(
    private readonly repository: Pick<PostgresAuthRepository, 'hbaPath' | 'readHbaFile' | 'readHbaBackup' | 'writeHbaFile' | 'reload'>,
    private readonly logger: PostgresAuthLogger,
    private readonly reporter: PostgresAuthReporter,
  ) {}

  static isManaged(content: string): boolean {
    return content.split('\n', 1)[0].trim() === PostgresHbaRestore.MANAGED_HEADER;
  }

  /**
   * Puts the pre-switch hba file back. `reload` is false only when the managed
   * file cannot have been loaded (a fresh switch failed before its reload): the
   * running rules are still the old ones, so restoring the file is enough.
   * True on success; never throws.
   */
  async restore(reason: string, reload: boolean): Promise<boolean> {
    try {
      const path = await this.repository.hbaPath();
      const restore = await this.restoreContent(path);

      if (restore !== null) {
        await this.repository.writeHbaFile(path, restore);
      }
      if (reload) {
        await this.repository.reload();
      }
      this.logger.warn(`[PostgresAuth] rolled back: ${ reason }`);

      return true;
    } catch (error) {
      this.logger.warn(`[PostgresAuth] rollback failed (${ reason }): ${ this.reporter.describe(error, '') }`);

      return false;
    }
  }

  /** Trust was decided: a managed file must not stay on disk (or loaded). Never throws. */
  async restoreIfManaged(reason: string): Promise<void> {
    let managed: boolean;

    try {
      managed = PostgresHbaRestore.isManaged(await this.repository.readHbaFile(await this.repository.hbaPath()));
    } catch (error) {
      this.logger.warn(`[PostgresAuth] could not check the hba file after keeping trust: ${ this.reporter.describe(error, '') }`);

      return;
    }
    if (managed) {
      await this.restore(reason, true);
    }
  }

  private async restoreContent(path: string): Promise<string | null> {
    const backup = await this.repository.readHbaBackup(path);

    if (backup !== null && !PostgresHbaRestore.isManaged(backup)) {
      return backup;
    }

    return PostgresHbaRestore.isManaged(await this.repository.readHbaFile(path)) ? PostgresHbaRestore.TRUST_HBA : null;
  }
}
