// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { PackageUpdater, type PackageInstallerPort } from './PackageUpdater';

class FakeInstaller implements PackageInstallerPort {
  calls: string[] = [];
  constructor(private readonly fail: Partial<Record<'install' | 'uninstall' | 'setActive', string>> = {}) {}
  async install(templateId: string) { this.calls.push(`install:${ templateId }`); return this.answer('install') }
  async uninstall(slug: string, removeData: boolean) { this.calls.push(`uninstall:${ slug }:${ removeData }`); return this.answer('uninstall') }
  async setActive(slug: string, active: boolean) { this.calls.push(`setActive:${ slug }:${ active }`); return this.answer('setActive') }
  private answer(step: 'install' | 'uninstall' | 'setActive') { return this.fail[step] ? { ok: false, error: this.fail[step] } : { ok: true } }
}

const latest = { id: 'tpl-2', title: 'Inbox Helper' };

describe('PackageUpdater', () => {
  it('removes the old version keeping its data, then installs the new one', async() => {
    // risk: irreversible side effect — an update must never delete the user's Docker volumes.
    const installer = new FakeInstaller();
    const result = await new PackageUpdater(installer).update({ slug: 'inbox', active: true }, latest);
    expect(result).toEqual({ ok: true });
    expect(installer.calls).toEqual(['uninstall:inbox:false', 'install:tpl-2']);
  });

  it('keeps a package that was off switched off after the update', async() => {
    // risk: core business rule — an update must not silently start a use case the user had turned off.
    const installer = new FakeInstaller();
    await new PackageUpdater(installer).update({ slug: 'inbox', active: false }, latest);
    expect(installer.calls).toEqual(['uninstall:inbox:false', 'install:tpl-2', 'setActive:inbox:false']);
  });

  it('does not install when the old version could not be removed', async() => {
    // risk: data accuracy — installing over a half-removed package would leave two versions.
    const installer = new FakeInstaller({ uninstall: 'busy' });
    const result = await new PackageUpdater(installer).update({ slug: 'inbox', active: true }, latest);
    expect(result).toEqual({ ok: false, error: 'busy' });
    expect(installer.calls).toEqual(['uninstall:inbox:false']);
  });

  it('says plainly that the old version is gone when the new one fails to install', async() => {
    // risk: failure must be visible — the user has to know to get the package again.
    const installer = new FakeInstaller({ install: 'offline' });
    const result = await new PackageUpdater(installer).update({ slug: 'inbox', active: true }, latest);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('offline');
    expect(result.error).toContain('Get it again');
  });
});
