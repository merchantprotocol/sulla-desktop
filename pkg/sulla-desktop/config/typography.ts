// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Per-section typography preferences.
 *
 * Every field is optional: an unset field means "keep the theme's look".
 * Values become `--type-*` CSS variables on <html>; component styles read
 * them with their previous value as the `var()` fallback, so the defaults
 * produce no visual change.
 */

export const FONT_PRESETS = {
  sans:    { label: 'System Sans', stack: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif" },
  serif:   { label: 'Serif', stack: "ui-serif, 'New York', Georgia, 'Times New Roman', serif" },
  mono:    { label: 'Mono', stack: "ui-monospace, 'SF Mono', Menlo, monospace" },
  rounded: { label: 'Rounded', stack: "ui-rounded, 'SF Pro Rounded', -apple-system, BlinkMacSystemFont, sans-serif" },
} as const;

/** Theme token names, never raw colours, so every choice stays readable in light and dark. */
export const COLOR_PRESETS = {
  primary:   { label: 'Primary', token: 'var(--text-primary)' },
  secondary: { label: 'Secondary', token: 'var(--text-secondary)' },
  muted:     { label: 'Muted', token: 'var(--text-muted)' },
  accent:    { label: 'Accent', token: 'var(--accent)' },
  link:      { label: 'Link', token: 'var(--text-link, var(--accent))' },
} as const;

export type FontPreset = keyof typeof FONT_PRESETS;
export type ColorPreset = keyof typeof COLOR_PRESETS;

export interface BasicTypography {
  font?:  FontPreset;
  size?:  number;
  color?: ColorPreset;
}

export interface OutputTypography extends BasicTypography {
  leading?: number;
}

export interface FormattingTypography {
  headingScale?: number;
  headingColor?: ColorPreset;
  codeFont?:     FontPreset;
  codeSize?:     number;
  linkColor?:    ColorPreset;
}

export interface TypographySettings {
  menus:      BasicTypography;
  tabs:       BasicTypography;
  sidebar:    BasicTypography;
  output:     OutputTypography;
  formatting: FormattingTypography;
}

export type TypographySectionId = keyof TypographySettings;
export type BasicSectionId = 'menus' | 'tabs' | 'sidebar' | 'output';

export interface NumberRange { min: number; max: number; step: number; base: number }

/** Slider bounds; `base` is the theme's current value, shown while the field is unset. */
export const SIZE_RANGES: Record<BasicSectionId, NumberRange> = {
  menus:   { min: 11, max: 18, step: 1, base: 13 },
  tabs:    { min: 11, max: 17, step: 1, base: 13 },
  sidebar: { min: 11, max: 18, step: 1, base: 13 },
  output:  { min: 12, max: 24, step: 0.5, base: 14.5 },
};
export const LEADING_RANGE: NumberRange = { min: 1.2, max: 2.2, step: 0.05, base: 1.65 };
export const HEADING_SCALE_RANGE: NumberRange = { min: 0.8, max: 1.6, step: 0.05, base: 1 };
export const CODE_SIZE_RANGE: NumberRange = { min: 10, max: 20, step: 0.5, base: 12.5 };

export const TYPOGRAPHY_SETTING_KEY = 'typography';
export const TYPOGRAPHY_STORAGE_KEY = 'sulla-typography';
/** `--type-link-color` → `type-has-link-color`: lets CSS apply rules that have no safe fallback only while set. */
export function typographyFlagClass(varName: string): string {
  return varName.replace(/^--type-/, 'type-has-');
}

export function emptyTypography(): TypographySettings {
  return { menus: {}, tabs: {}, sidebar: {}, output: {}, formatting: {} };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function font(value: unknown): FontPreset | undefined {
  return typeof value === 'string' && Object.hasOwn(FONT_PRESETS, value) ? value as FontPreset : undefined;
}

function color(value: unknown): ColorPreset | undefined {
  return typeof value === 'string' && Object.hasOwn(COLOR_PRESETS, value) ? value as ColorPreset : undefined;
}

/** Finite numbers are clamped into range and snapped to its step; anything else is dropped. */
export function clampToRange(value: unknown, range: NumberRange): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const clamped = Math.min(range.max, Math.max(range.min, value));
  const snapped = range.min + Math.round((clamped - range.min) / range.step) * range.step;

  return Number(Math.min(range.max, snapped).toFixed(3));
}

function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

function basic(value: unknown, section: BasicSectionId): BasicTypography {
  const raw = record(value);

  return compact({ font: font(raw.font), size: clampToRange(raw.size, SIZE_RANGES[section]), color: color(raw.color) });
}

/** Accepts anything read from storage and returns only valid, in-range settings. */
export function sanitizeTypography(value: unknown): TypographySettings {
  const raw = record(typeof value === 'string' ? safeParse(value) : value);
  const output = record(raw.output);
  const formatting = record(raw.formatting);

  return {
    menus:      basic(raw.menus, 'menus'),
    tabs:       basic(raw.tabs, 'tabs'),
    sidebar:    basic(raw.sidebar, 'sidebar'),
    output:     compact({ ...basic(output, 'output'), leading: clampToRange(output.leading, LEADING_RANGE) }),
    formatting: compact({
      headingScale: clampToRange(formatting.headingScale, HEADING_SCALE_RANGE),
      headingColor: color(formatting.headingColor),
      codeFont:     font(formatting.codeFont),
      codeSize:     clampToRange(formatting.codeSize, CODE_SIZE_RANGE),
      linkColor:    color(formatting.linkColor),
    }),
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** CSS custom properties for the set fields only; unset fields stay absent so fallbacks apply. */
export function typographyCssVars(settings: TypographySettings): Record<string, string> {
  const vars: Record<string, string> = {};
  const put = (name: string, value: string | undefined) => {
    if (value !== undefined) vars[`--type-${ name }`] = value;
  };

  for (const section of ['menus', 'tabs', 'sidebar', 'output'] as const) {
    const s = settings[section];

    put(`${ section }-font`, s.font && FONT_PRESETS[s.font].stack);
    put(`${ section }-size`, s.size === undefined ? undefined : `${ s.size }px`);
    put(`${ section }-color`, s.color && COLOR_PRESETS[s.color].token);
  }
  put('output-leading', settings.output.leading?.toString());

  const f = settings.formatting;

  put('heading-scale', f.headingScale?.toString());
  put('heading-color', f.headingColor && COLOR_PRESETS[f.headingColor].token);
  put('code-font', f.codeFont && FONT_PRESETS[f.codeFont].stack);
  put('code-size', f.codeSize === undefined ? undefined : `${ f.codeSize }px`);
  put('link-color', f.linkColor && COLOR_PRESETS[f.linkColor].token);

  return vars;
}

export function isTypographyDefault(settings: TypographySettings): boolean {
  return Object.keys(typographyCssVars(settings)).length === 0;
}
