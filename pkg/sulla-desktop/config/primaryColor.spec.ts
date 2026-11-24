// SPDX-License-Identifier: GPL-2.0-or-later
import { describe, expect, it } from 'vitest';

import {
  primaryColorContrast, primaryColorCssVars, primaryColorPalette, sanitizePrimaryColor,
} from './primaryColor';

describe('primary color value safety and accessible palette', () => {
  // risk: permissions/RBAC — only a safe six-digit color reaches CSS custom properties.
  it('canonicalizes valid hex and rejects values that could inject CSS', () => {
    expect(sanitizePrimaryColor(' #6B57C9 ')).toBe('#6b57c9');
    for (const invalid of ['red', '#fff', '#12345', '#12345678', 'url(javascript:alert(1))', null, 42]) {
      expect(sanitizePrimaryColor(invalid)).toBeNull();
    }
  });

  // risk: data accuracy — both normal and hover fills must remain WCAG AA readable for every hue.
  it('chooses black or white with at least 4.5:1 contrast on primary and hover fills', () => {
    for (const color of ['#ffffff', '#000000', '#ffff00', '#777777', '#2b7694', '#6b57c9']) {
      const palette = primaryColorPalette(color)!;

      expect(['#000000', '#ffffff']).toContain(palette.onPrimary);
      expect(['#000000', '#ffffff']).toContain(palette.onHover);
      expect(primaryColorContrast(palette.onPrimary, palette.primary)).toBeGreaterThanOrEqual(4.5);
      expect(primaryColorContrast(palette.onHover, palette.hover)).toBeGreaterThanOrEqual(4.5);
    }
    expect(primaryColorPalette('not-a-color')).toBeNull();
    expect(primaryColorContrast('#fff', '#000')).toBeNull();
  });

  // risk: accessibility — arbitrary light/dark custom hues must remain readable when used as accent text.
  it('derives a mode-aware text accent with readable contrast on the theme surface', () => {
    for (const color of ['#ffffff', '#000000', '#ffff00', '#777777', '#2b7694', '#6b57c9']) {
      const light = primaryColorPalette(color, 'light')!;
      const dark = primaryColorPalette(color, 'dark')!;

      expect(primaryColorContrast(light.textAccent, '#ffffff')).toBeGreaterThanOrEqual(4.5);
      expect(primaryColorContrast(dark.textAccent, '#2e3440')).toBeGreaterThanOrEqual(4.5);
    }
  });

  // risk: accessibility — dark-mode fills stay distinct from dark surfaces and select readable text for both states.
  it('derives dark-mode fills and Studio aliases from the selected hue', () => {
    for (const color of ['#000000', '#2b7694', '#6b57c9', '#ffffff']) {
      const palette = primaryColorPalette(color, 'dark')!;

      expect(primaryColorContrast(palette.primary, '#2e3440')).toBeGreaterThanOrEqual(3);
      expect(primaryColorContrast(palette.hover, '#2e3440')).toBeGreaterThanOrEqual(3);
      expect(primaryColorContrast(palette.onPrimary, palette.primary)).toBeGreaterThanOrEqual(4.5);
      expect(primaryColorContrast(palette.onHover, palette.hover)).toBeGreaterThanOrEqual(4.5);
    }

    const vars = primaryColorCssVars('#6b57c9', 'dark');
    expect(vars['--mk-accent']).toBe(primaryColorPalette('#6b57c9', 'dark')?.primary);
    expect(vars['--mk-on-accent']).toBe(primaryColorPalette('#6b57c9', 'dark')?.onPrimary);
    expect(vars['--nx-accent']).toBe(primaryColorPalette('#6b57c9', 'dark')?.primary);
    expect(vars['--primary-color-override']).toBe(primaryColorPalette('#6b57c9', 'dark')?.primary);
    expect(vars['--primary-color-text-override']).toBe(primaryColorPalette('#6b57c9', 'dark')?.textAccent);
    expect(vars['--primary-color-surface-override']).toContain('var(--bg-surface');
  });
});
