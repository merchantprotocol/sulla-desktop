// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ComposerGlow } from '@pkg/pages/chat/components/composer/ComposerGlow';

describe('Capsule composer glow', () => {
  afterEach(() => vi.useRealTimers());

  // risk: availability — sub-agent work must keep the glow active while the primary agent is idle.
  it('stays active for a working thread agent and turns off when every agent is idle', () => {
    vi.useFakeTimers();
    const glow = new ComposerGlow();
    glow.setActive(ComposerGlow.isRunning(false, [{ state: 'working' }]));
    expect(glow.state.active).toBe(true);

    glow.setActive(ComposerGlow.isRunning(false, [{ state: 'quiet' }, { state: 'done' }]));
    expect(glow.state.active).toBe(false);
    glow.dispose();
  });

  // risk: UI accuracy — the primary-color preference takes precedence, with the active theme accent as its fallback.
  it('resolves the live primary setting before falling back to the theme accent', () => {
    expect(ComposerGlow.resolveColor('#6b57c9', 'var(--accent)')).toBe('#6b57c9');
    expect(ComposerGlow.resolveColor(null, 'var(--accent)')).toBe('var(--primary-color-override, var(--accent))');
    expect(ComposerGlow.resolveColor('  ', 'var(--accent)')).toBe('var(--primary-color-override, var(--accent))');
  });
});
