// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { describe, expect, it, vi } from 'vitest';

import {
  emptyTypography, isTypographyDefault, sanitizeTypography, typographyCssVars, typographyFlagClass,
} from '@pkg/config/typography';

vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));

const { applyTypography } = await import('@pkg/composables/useTypography');

describe('typography settings', () => {
  // risk: the defaults must leave every section looking exactly like the theme
  it('emits no CSS variables until the user changes something', () => {
    expect(typographyCssVars(emptyTypography())).toEqual({});
    expect(isTypographyDefault(sanitizeTypography(undefined))).toBe(true);
  });

  // risk: a corrupted or hand-edited stored value must not break layout or inject CSS
  it('drops unknown presets and junk instead of passing them to CSS', () => {
    const clean = sanitizeTypography({
      menus:      { font: 'Comic Sans; color: red', size: 'huge', color: 'url(evil)' },
      output:     { font: 'serif', color: '#ff0000' },
      formatting: { codeFont: 'mono', linkColor: 'accent', extra: 1 },
      bogus:      { size: 12 },
    });

    expect(clean.menus).toEqual({});
    expect(clean.output).toEqual({ font: 'serif' });
    expect(clean.formatting).toEqual({ codeFont: 'mono', linkColor: 'accent' });
    expect(Object.keys(clean)).toEqual(['menus', 'tabs', 'sidebar', 'output', 'formatting']);
  });

  // risk: unreadably tiny or huge text from a bad value
  it('clamps sizes into the section range and snaps to its step', () => {
    const clean = sanitizeTypography({ tabs: { size: 4 }, sidebar: { size: 400 }, output: { size: 15.3, leading: 9 } });

    expect(clean.tabs.size).toBe(11);
    expect(clean.sidebar.size).toBe(18);
    expect(clean.output.size).toBe(15.5);
    expect(clean.output.leading).toBe(2.2);
  });

  it('reads the JSON string form stored by the settings table', () => {
    expect(sanitizeTypography(JSON.stringify({ sidebar: { size: 15 } })).sidebar).toEqual({ size: 15 });
    expect(sanitizeTypography('{not json').sidebar).toEqual({});
  });

  // risk: colours must follow the theme so they stay readable in light and dark
  it('maps choices to font stacks and theme tokens, never raw colours', () => {
    const vars = typographyCssVars(sanitizeTypography({
      sidebar:    { font: 'rounded', size: 15, color: 'muted' },
      formatting: { headingScale: 1.2, codeSize: 14 },
    }));

    expect(vars).toEqual({
      '--type-sidebar-font':   expect.stringContaining('ui-rounded'),
      '--type-sidebar-size':   '15px',
      '--type-sidebar-color':  'var(--text-muted)',
      '--type-heading-scale':  '1.2',
      '--type-code-size':      '14px',
    });
  });
});

describe('applyTypography', () => {
  function fakeRoot() {
    const props = new Map<string, string>();
    const classes = new Set<string>();

    return {
      props,
      classes,
      root: {
        style:     { setProperty: (k: string, v: string) => props.set(k, v), removeProperty: (k: string) => props.delete(k) },
        classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) },
      } as unknown as HTMLElement,
    };
  }

  // risk: resetting a section must actually restore the theme look, not leave stale variables behind
  it('removes variables and flags for fields that were reset', () => {
    const { root, props, classes } = fakeRoot();

    applyTypography(sanitizeTypography({ formatting: { linkColor: 'accent', headingScale: 1.3 } }), root);
    expect(props.get('--type-link-color')).toBe('var(--accent)');
    expect(classes).toEqual(new Set(['type-has-link-color', 'type-has-heading-scale']));

    applyTypography(sanitizeTypography({ formatting: { headingScale: 1.3 } }), root);
    expect(props.has('--type-link-color')).toBe(false);
    expect(classes).toEqual(new Set([typographyFlagClass('--type-heading-scale')]));
  });
});
