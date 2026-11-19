// SPDX-License-Identifier: GPL-2.0-or-later
// @vitest-environment jsdom
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

import { VAULT_THEME_TOKENS, readVaultTheme, vaultThemeCss } from '@pkg/shared/vaultTheme';
const theme = () => ({ dark: true, colors: Object.fromEntries(VAULT_THEME_TOKENS.map(token => [token, 'rgb(12, 20, 30)'])) });
describe('vault presentation bridge', () => {
  it('resolves only public theme colors without returning page contents', () => {
    document.documentElement.classList.add('dark');
    for (const token of VAULT_THEME_TOKENS) document.documentElement.style.setProperty(`--${ token }`, 'rgb(12, 20, 30)');
    const value = readVaultTheme(document);
    expect(value.dark).toBe(true); expect(Object.keys(value.colors)).toEqual([...VAULT_THEME_TOKENS]);
    expect(document.querySelector('span')).toBeNull();
  });
  it('maps both modes onto the existing console palette', () => {
    expect(vaultThemeCss(theme())).toContain('color-scheme:dark');
    expect(vaultThemeCss({ ...theme(), dark: false })).toContain('color-scheme:light');
    expect(vaultThemeCss(theme())).toContain('--paper:var(--bg-page)');
    expect(vaultThemeCss({ ...theme(), colors: { ...theme().colors, 'bg-page': 'oklch(0.966 0.012 240)' } })).toContain('oklch(0.966 0.012 240)');
  });
  it('rejects missing colors and CSS injection rather than accepting arbitrary style text', () => {
    for (const color of ['red; background:url(https://example.com)', 'url(secret)', 'var(--secret)', '#fff']) {
      const value = theme(); value.colors['bg-page'] = color;
      expect(() => vaultThemeCss(value)).toThrow('Invalid vault theme color');
    }
    expect(() => vaultThemeCss({ dark: true, colors: {} })).toThrow();
    expect(() => vaultThemeCss(null)).toThrow();
  });
  // The provider page ships its own author stylesheet (e.g. :root{--paper:#f4f7fb} body{background:...}).
  // insertCSS adds ours as another author sheet, so only !important reliably wins, whatever the order
  // or specificity of the provider rules. jsdom 26 ignores !important across sheets and does not
  // resolve var(), so the real cascade is verified in the native BrowserView, not here.
  it('emits only important declarations so the provider stylesheet cannot override the theme', () => {
    for (const dark of [true, false]) {
      const sheet = postcss.parse(vaultThemeCss({ ...theme(), dark }));
      const declarations: { selector: string; prop: string; value: string; important: boolean }[] = [];
      sheet.walkDecls(decl => { declarations.push({ selector: (decl.parent as postcss.Rule).selector, prop: decl.prop, value: decl.value, important: decl.important }) });
      expect(declarations.length).toBeGreaterThan(VAULT_THEME_TOKENS.length);
      expect(declarations.filter(decl => !decl.important)).toEqual([]);
      // The provider's own variables and page background resolve to the injected theme.
      expect(declarations).toEqual(expect.arrayContaining([
        expect.objectContaining({ prop: '--paper', value: 'var(--bg-page)', important: true }),
        expect.objectContaining({ prop: '--bg-page', value: 'rgb(12, 20, 30)', important: true }),
        expect.objectContaining({ selector: 'body', prop: 'background', value: 'var(--bg-page)', important: true }),
        expect.objectContaining({ selector: 'body', prop: 'color', value: 'var(--text-primary)', important: true }),
        expect.objectContaining({ prop: 'color-scheme', value: dark ? 'dark' : 'light', important: true }),
      ]));
      // Still a fixed allowlist: no arbitrary properties or URLs.
      expect(declarations.filter(decl => !decl.prop.startsWith('--') && !['color-scheme', 'background', 'color'].includes(decl.prop))).toEqual([]);
      expect(declarations.filter(decl => /url\(|expression|@import/i.test(decl.value))).toEqual([]);
    }
  });
});
