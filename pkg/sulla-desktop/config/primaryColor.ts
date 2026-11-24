// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** Persisted override for the theme's primary/accent color. */
export const PRIMARY_COLOR_SETTING_KEY = 'primaryColor';
export const PRIMARY_COLOR_STORAGE_KEY = 'agentPrimaryColor';
export const PRIMARY_COLOR_OVERRIDE_CLASS = 'has-primary-color-override';

/** Presets shown in the approved worker-chart mockup, plus a custom picker. */
export const PRIMARY_COLOR_PRESETS = [
  { label: 'Steel blue', value: '#2b7694' },
  { label: 'Violet', value: '#6b57c9' },
  { label: 'Graphite', value: '#3d4654' },
] as const;

export interface PrimaryColorPalette {
  primary: string;
  hover: string;
  textAccent: string;
  onPrimary: '#000000' | '#ffffff';
  onHover: '#000000' | '#ffffff';
  tint: string;
  surfaceTint: string;
  surfaceTintStrong: string;
  surfaceTintHover: string;
  border: string;
  ring: string;
  glow: string;
  glowSoft: string;
  glowStrong: string;
}

export type PrimaryColorMode = 'light' | 'dark';

/** Accept only a six-digit hex color; canonicalize case before CSS/storage use. */
export function sanitizePrimaryColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const color = value.trim();

  return /^#[\da-f]{6}$/i.test(color) ? color.toLowerCase() : null;
}

function channels(value: string): [number, number, number] {
  return [1, 3, 5].map(index => Number.parseInt(value.slice(index, index + 2), 16)) as [number, number, number];
}

function toHex(value: number): string {
  return Math.min(255, Math.max(0, Math.round(value))).toString(16).padStart(2, '0');
}

/** Relative WCAG 2.1 luminance for one sanitized sRGB hex color. */
export function primaryColorLuminance(value: unknown): number | null {
  const color = sanitizePrimaryColor(value);
  if (!color) return null;
  const linear = channels(color).map(channel => {
    const srgb = channel / 255;

    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

/** WCAG 2.1 contrast ratio; invalid input returns null rather than guessing. */
export function primaryColorContrast(first: unknown, second: unknown): number | null {
  const firstLuminance = primaryColorLuminance(first);
  const secondLuminance = primaryColorLuminance(second);
  if (firstLuminance === null || secondLuminance === null) return null;
  const brightest = Math.max(firstLuminance, secondLuminance);
  const darkest = Math.min(firstLuminance, secondLuminance);

  return (brightest + 0.05) / (darkest + 0.05);
}

function readableText(value: string): '#000000' | '#ffffff' {
  const black = primaryColorContrast('#000000', value)!;
  const white = primaryColorContrast('#ffffff', value)!;

  return black >= white ? '#000000' : '#ffffff';
}

function mixWithBlack(value: string, amount: number): string {
  const mixed = channels(value).map(channel => channel * (1 - amount));

  return `#${ mixed.map(toHex).join('') }`;
}

function mixWithWhite(value: string, amount: number): string {
  const mixed = channels(value).map(channel => channel * (1 - amount) + 255 * amount);

  return `#${ mixed.map(toHex).join('') }`;
}

/** Keep dark-theme fills distinct from even the lightest dark theme surface. */
function ensureDarkSurfaceContrast(value: string): string {
  const darkSurface = '#2e3440';
  let amount = 0;
  let result = value;

  while ((primaryColorContrast(result, darkSurface) ?? 0) < 3 && amount < 1) {
    amount = Math.min(1, amount + 0.05);
    result = mixWithWhite(value, amount);
  }

  return result;
}

/** Keep link and accent text readable on a light or dark theme surface. */
function ensureTextContrast(value: string, mode: PrimaryColorMode): string {
  const surface = mode === 'dark' ? '#2e3440' : '#ffffff';
  const surfaceLuminance = primaryColorLuminance(surface)!;
  const colorLuminance = primaryColorLuminance(value)!;
  let amount = 0;
  let result = value;

  while ((primaryColorContrast(result, surface) ?? 0) < 4.5 && amount < 1) {
    amount = Math.min(1, amount + 0.05);
    result = surfaceLuminance > colorLuminance
      ? mixWithBlack(value, amount)
      : mixWithWhite(value, amount);
  }

  return result;
}

/** Derive mode-specific fills plus tints and focus/glow colors. */
export function primaryColorPalette(value: unknown, mode: PrimaryColorMode = 'light'): PrimaryColorPalette | null {
  const selected = sanitizePrimaryColor(value);
  if (!selected) return null;
  const primary = mode === 'dark'
    ? ensureDarkSurfaceContrast(mixWithWhite(selected, 0.38))
    : selected;
  const hover = mode === 'dark'
    ? ensureDarkSurfaceContrast(mixWithWhite(selected, 0.50))
    : mixWithBlack(primary, 0.13);
  const textAccent = ensureTextContrast(selected, mode);

  return {
    primary,
    hover,
    textAccent,
    onPrimary: readableText(primary),
    onHover: readableText(hover),
    tint: `color-mix(in srgb, ${ primary } 12%, transparent)`,
    surfaceTint: `color-mix(in srgb, ${ primary } 10%, var(--bg-surface, #ffffff))`,
    surfaceTintStrong: `color-mix(in srgb, ${ primary } 22%, var(--bg-surface, #ffffff))`,
    surfaceTintHover: `color-mix(in srgb, ${ hover } 34%, var(--bg-surface, #ffffff))`,
    border: `color-mix(in srgb, ${ primary } 44%, transparent)`,
    ring: `color-mix(in srgb, ${ primary } 38%, transparent)`,
    glow: `color-mix(in srgb, ${ primary } 38%, transparent)`,
    glowSoft: `color-mix(in srgb, ${ primary } 15%, transparent)`,
    glowStrong: `color-mix(in srgb, ${ primary } 58%, transparent)`,
  };
}

/**
 * CSS overrides for the shared theme tokens. Callers omit all these values
 * when no override exists, leaving each theme's original declarations intact.
 */
export function primaryColorCssVars(value: unknown, mode: PrimaryColorMode = 'light'): Record<string, string> {
  const palette = primaryColorPalette(value, mode);
  if (!palette) return {};

  const {
    primary, hover, textAccent, onPrimary, onHover, tint, surfaceTint, surfaceTintStrong, surfaceTintHover,
    border, ring, glow, glowSoft, glowStrong,
  } = palette;

  return {
    '--primary-color-override': primary,
    '--primary-color-hover-override': hover,
    '--primary-color-text-override': textAccent,
    '--primary-color-surface-override': surfaceTint,
    '--primary-color-surface-strong-override': surfaceTintStrong,
    '--primary-color-surface-hover-override': surfaceTintHover,
    '--accent-primary': primary,
    '--accent-primary-hover': hover,
    '--accent': primary,
    '--accent-2': hover,
    '--accent-hover': hover,
    '--accent-dim': tint,
    '--accent-soft': tint,
    '--accent-line': border,
    '--accent-border': border,
    '--border-accent': border,
    '--border-focus': border,
    '--text-on-accent': onPrimary,
    '--text-on-accent-hover': onHover,
    '--on-accent': onPrimary,
    '--on-accent-hover': onHover,
    '--text-accent': textAccent,
    '--text-link': textAccent,
    '--bg-accent': tint,
    '--brand-glow': glow,
    '--brand-glow-soft': glowSoft,
    '--brand-glow-strong': glowStrong,
    '--accent-glow': glow,
    '--ring-color': ring,
    '--nx-accent': primary,
    '--nx-accent-2': hover,
    '--nx-glow': glow,
    '--nx-indicator-edge': border,
    '--primary-btn-bg': primary,
    '--primary-btn-hover-bg': hover,
    '--primary-btn-text': onPrimary,
    '--primary-btn-hover-text': onHover,
    '--primary': primary,
    '--primary-hover': hover,
    '--accent-btn': tint,
    '--accent-btn-hover': hover,
    '--accent-btn-hover-text': onHover,
    '--outline': primary,
    '--checkbox-ticked-bg': primary,
    '--dropdown-text': primary,
    '--dropdown-hover-bg': hover,
    '--terminal-cursor': primary,
    '--terminal-selection': border,
    '--sx-color-primary': primary,
    '--sx-color-on-primary': onPrimary,
    '--sx-color-on-primary-container': 'var(--text-primary)',
    '--sx-color-primary-container': `color-mix(in srgb, ${ primary } 15%, var(--bg-surface))`,
    '--sx-color-surface-tint': tint,
    '--mk-accent': primary,
    '--mk-on-accent': onPrimary,
    '--mk-sel': `color-mix(in srgb, ${ primary } 13%, var(--mk-bg))`,
    '--mk-hover': `color-mix(in srgb, ${ primary } 7%, var(--mk-bg))`,
    '--mk-ring': `0 0 0 3px ${ ring }`,
  };
}
