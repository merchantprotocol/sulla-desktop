// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { TAB_GROUP_COLOR_SWATCHES, type TabGroupColorToken } from '../shared/TabGroupColor';

import type { TabGroup } from './TabGroupModel';

export interface TabGroupColorTheme {
  lightness: string;
  chroma:    string;
}

/** Resolves the approved fixed-hue swatches against the current theme and chooses new-group colors. */
export class TabGroupColorPalette {
  styles(theme: TabGroupColorTheme): Record<string, string> {
    return Object.fromEntries(TAB_GROUP_COLOR_SWATCHES.map(swatch => [
      `--tab-group-swatch-${ swatch.token }`,
      this.color(swatch.token, theme),
    ]));
  }

  swatches(theme: TabGroupColorTheme): { token: TabGroupColorToken; label: string; color: string }[] {
    return TAB_GROUP_COLOR_SWATCHES.map(({ token, label }) => ({ token, label, color: this.color(token, theme) }));
  }

  nextToken(groups: readonly Pick<TabGroup, 'colorToken'>[]): TabGroupColorToken {
    const used = new Set(groups.map(group => group.colorToken));
    const available = TAB_GROUP_COLOR_SWATCHES.find(({ token }) => token !== 'grey' && !used.has(token));

    return available?.token ?? TAB_GROUP_COLOR_SWATCHES[groups.length % TAB_GROUP_COLOR_SWATCHES.length].token;
  }

  private color(token: TabGroupColorToken, theme: TabGroupColorTheme): string {
    const swatch = TAB_GROUP_COLOR_SWATCHES.find(candidate => candidate.token === token);

    if (!swatch) throw new RangeError('Unsupported tab group color token');
    const lightness = 'lightnessOffset' in swatch ? `calc(${ theme.lightness } + ${ swatch.lightnessOffset }%)` : theme.lightness;
    const chroma = 'chroma' in swatch ? swatch.chroma : theme.chroma;

    return `oklch(${ lightness } ${ chroma } ${ swatch.hue })`;
  }
}
