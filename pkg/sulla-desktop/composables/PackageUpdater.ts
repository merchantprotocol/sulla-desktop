// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** The package installer calls an update needs (the `packages:*` IPC in the app). */
export interface PackageInstallerPort {
  install(templateId: string): Promise<{ ok: boolean; error?: string }>;
  uninstall(slug: string, removeData: boolean): Promise<{ ok: boolean; error?: string }>;
  setActive(slug: string, active: boolean): Promise<{ ok: boolean; error?: string }>;
}

export interface PackageUpdateResult { ok: boolean; error?: string }

/**
 * Updates an installed use case to the version listed in Use Cases.
 *
 * The installer refuses to install a package that is already installed, so
 * an update removes the old version while keeping its data (Docker volumes and
 * anything the user created or edited are left in place), installs the new
 * version, then puts back the on/off state the user had chosen.
 */
export class PackageUpdater {
  constructor(private readonly installer: PackageInstallerPort) {}

  async update(installed: { slug: string; active: boolean }, latest: { id: string; title: string }): Promise<PackageUpdateResult> {
    const removed = await this.installer.uninstall(installed.slug, false);
    if (!removed.ok) return { ok: false, error: removed.error || `Couldn't remove the old version of ${ latest.title }.` };

    const added = await this.installer.install(latest.id);
    if (!added.ok) {
      return {
        ok:    false,
        error: `The old version of ${ latest.title } was removed (your data was kept), but the new version didn't install: ${ added.error || 'no reason given' }. Get it again from Browse.`,
      };
    }

    if (!installed.active) {
      const off = await this.installer.setActive(installed.slug, false);
      if (!off.ok) return { ok: false, error: `${ latest.title } updated, but it couldn't be switched back off: ${ off.error || 'no reason given' }.` };
    }

    return { ok: true };
  }
}
