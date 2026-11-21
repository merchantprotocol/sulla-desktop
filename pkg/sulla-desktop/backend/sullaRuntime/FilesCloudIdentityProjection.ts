// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Projects only the persisted canonical Cloud ID into Files' Compose environment. */
export class FilesCloudIdentityProjection {
  static readonly GUEST_ENV_FILE = '/tmp/sulla-files-cloud-identity.env';

  private projected: string | null | undefined;

  constructor(
    private readonly readExisting: () => string | null,
    private readonly writeEnvironment: (contents: string) => Promise<void>,
  ) {}

  /** Call inside the Compose queue, immediately before a managed Files lifecycle action. */
  async refresh(force = false): Promise<boolean> {
    const current = this.readExisting();
    const changed = current !== this.projected;

    if (changed || force) {
      // Explicitly empty rather than inheriting any guest environment value.
      await this.writeEnvironment(`SULLA_FILES_CLOUD_DEVICE_ID=${ current ?? '' }\n`);
      this.projected = current;
    }

    return changed;
  }
}
