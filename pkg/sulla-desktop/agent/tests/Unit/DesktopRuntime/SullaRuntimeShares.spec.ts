// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { sullaRuntimeShareList } from '@pkg/backend/sullaRuntime/shares';

const cache = '/Users/me/Library/Caches/sulla-desktop';
const logs = '/Users/me/Library/Logs/sulla-desktop';

describe('sullaRuntimeShareList', () => {
  // risk: packaged builds must keep the narrow app-owned share set — no user code or home crosses into the VM
  it('shares only app-owned folders for a packaged app', () => {
    const resources = '/Applications/Sulla Desktop.app/Contents/Resources/resources';
    const shares = sullaRuntimeShareList([cache, logs], resources);

    expect(shares.map(share => share.hostPath)).toEqual(['/tmp/sulla-desktop', cache, logs, resources]);
    expect(shares.filter(share => share.readOnly).map(share => share.hostPath)).toEqual([resources]);
  });

  // risk: source checkouts build services/<name>/Dockerfile inside the guest; without the checkout share every build fails with lstat ENOENT
  it('shares a source checkout read-only so guest builds can see services/', () => {
    const repo = '/Users/me/Code/SullaDesktop';
    const shares = sullaRuntimeShareList([cache, logs], `${ repo }/resources`, repo);
    const repoShare = shares.find(share => share.hostPath === repo);

    expect(repoShare).toBeDefined();
    expect(repoShare?.readOnly).toBe(true);
    // resources/ lives inside the checkout, so it is covered by the read-only checkout share rather than mounted twice
    expect(shares.some(share => share.hostPath === `${ repo }/resources`)).toBe(false);
    expect(shares.filter(share => !share.readOnly).map(share => share.hostPath)).toEqual(['/tmp/sulla-desktop', cache, logs]);
  });

  it('gives every share a distinct tag', () => {
    const shares = sullaRuntimeShareList([cache, logs], '/repo/resources', '/repo');

    expect(new Set(shares.map(share => share.tag)).size).toBe(shares.length);
  });
});
