// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it } from 'vitest';

import { SullaServiceStartupDecision } from './SullaServiceStartupDecision';

describe('SullaServiceStartupDecision', () => {
  const decision = new SullaServiceStartupDecision();

  // risk: availability — a service from an older install must not survive an app upgrade.
  it('recreates only when a running image differs from the installed app pin', () => {
    expect(decision.imageAction('sha256:old', 'sha256:new')).toBe('recreate');
    expect(decision.imageAction('sha256:new', 'sha256:new')).toBe('keep');
    expect(decision.imageAction('sha256:old')).toBe('keep');
  });

  // risk: availability — a stopped FUSE adapter leaves the shared Files mount unavailable.
  it('starts the Files adapter when its container is exited or missing', () => {
    expect(decision.fuseAction('exited 143 none')).toBe('start');
    expect(decision.fuseAction('')).toBe('start');
    expect(decision.fuseAction('running healthy')).toBe('keep');
  });
});
