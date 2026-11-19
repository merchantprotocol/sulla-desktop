// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it, vi } from 'vitest';
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: {} }));
vi.mock('@pkg/composables/useTypography', () => ({ startTypography: vi.fn() }));
vi.mock('@pkg/utils/ipcRenderer', () => ({ ipcRenderer: { on: vi.fn() } }));
import { availableThemes, oppositeModeTheme } from '@pkg/composables/useTheme';

describe('theme mode switch', () => {
  it('always selects the opposite mode, including light-only Studio', () => {
    for (const theme of availableThemes) {
      const target = availableThemes.find(candidate => candidate.id === oppositeModeTheme(theme.id));
      expect(target?.mode).toBe(theme.mode === 'dark' ? 'light' : 'dark');
    }
    expect(oppositeModeTheme('studio-light')).toBe('default-dark');
  });
  it('preserves paired color schemes', () => {
    expect(oppositeModeTheme('ocean-light')).toBe('ocean-dark');
    expect(oppositeModeTheme('noir-dark')).toBe('noir-light');
  });
  it('recovers unknown saved themes', () => {
    expect(oppositeModeTheme('unknown')).toBe('default-light');
  });
});
