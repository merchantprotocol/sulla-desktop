// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Fixed hues from the approved picker; lightness and chroma are supplied by the active theme. */
export const TAB_GROUP_COLOR_SWATCHES = [
  { token: 'grey', label: 'Grey', hue: 250, chroma: '.02' },
  { token: 'blue', label: 'Blue', hue: 240 },
  { token: 'cyan', label: 'Cyan', hue: 205 },
  { token: 'green', label: 'Green', hue: 150 },
  { token: 'gold', label: 'Gold', hue: 90, lightnessOffset: 8 },
  { token: 'orange', label: 'Orange', hue: 45 },
  { token: 'pink', label: 'Pink', hue: 350 },
  { token: 'purple', label: 'Purple', hue: 300 },
] as const;

export type TabGroupColorToken = typeof TAB_GROUP_COLOR_SWATCHES[number]['token'];

/** Persist only user-facing swatch keys, never computed color values. */
export const TAB_GROUP_COLOR_TOKENS: readonly TabGroupColorToken[] = TAB_GROUP_COLOR_SWATCHES.map(({ token }) => token);
