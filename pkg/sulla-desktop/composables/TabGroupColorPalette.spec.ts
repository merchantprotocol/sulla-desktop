// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it } from 'vitest';

import { TabGroupColorPalette } from './TabGroupColorPalette';

describe('tab group color palette', () => {
  it('uses the approved fixed hues with lightness and chroma supplied by the theme', () => {
    // risk: data accuracy — group colors must match the eight mockup keys and adapt to light/dark theme levels.
    const palette = new TabGroupColorPalette();

    expect(palette.swatches({ lightness: '56%', chroma: '.15' })).toEqual([
      { token: 'grey', label: 'Grey', color: 'oklch(56% .02 250)' },
      { token: 'blue', label: 'Blue', color: 'oklch(56% .15 240)' },
      { token: 'cyan', label: 'Cyan', color: 'oklch(56% .15 205)' },
      { token: 'green', label: 'Green', color: 'oklch(56% .15 150)' },
      { token: 'gold', label: 'Gold', color: 'oklch(calc(56% + 8%) .15 90)' },
      { token: 'orange', label: 'Orange', color: 'oklch(56% .15 45)' },
      { token: 'pink', label: 'Pink', color: 'oklch(56% .15 350)' },
      { token: 'purple', label: 'Purple', color: 'oklch(56% .15 300)' },
    ]);
    expect(palette.swatches({ lightness: '74%', chroma: '.12' })[1].color).toBe('oklch(74% .12 240)');
  });

  it('chooses unused non-grey swatches first and then cycles the full palette', () => {
    // risk: data accuracy — new groups receive the mockup's deterministic first-unused default.
    const palette = new TabGroupColorPalette();
    const groups = (tokens: string[]) => tokens.map(colorToken => ({ colorToken: colorToken as never }));

    expect(palette.nextToken([])).toBe('blue');
    expect(palette.nextToken(groups(['blue', 'cyan']))).toBe('green');
    expect(palette.nextToken(groups(['blue', 'cyan', 'green', 'gold', 'orange', 'pink', 'purple']))).toBe('purple');
    expect(palette.nextToken(groups(['blue', 'cyan', 'green', 'gold', 'orange', 'pink', 'purple', 'grey']))).toBe('grey');
  });
});
