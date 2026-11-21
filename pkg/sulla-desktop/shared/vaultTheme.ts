// SPDX-License-Identifier: GPL-2.0-or-later

/** Public presentation only. No vault contents or authentication data cross this bridge. */
export const VAULT_THEME_TOKENS = [
  'bg-page', 'bg-surface', 'bg-surface-alt', 'bg-input', 'bg-header',
  'text-primary', 'text-secondary', 'text-muted', 'text-on-accent',
  'border-default', 'border-strong', 'border-subtle',
  'accent-primary', 'accent-primary-hover', 'bg-info', 'border-info',
  'status-success', 'status-warning', 'status-error', 'bg-success', 'bg-warning', 'bg-error',
] as const;
export interface VaultTheme {
  dark:   boolean;
  colors: Record<string, string>;
}

export function readVaultTheme(doc: Document): VaultTheme {
  const probe = doc.createElement('span');
  probe.hidden = true;
  doc.documentElement.append(probe);
  try {
    const colors: Record<string, string> = {};
    for (const token of VAULT_THEME_TOKENS) {
      probe.style.color = `var(--${ token })`;
      colors[token] = doc.defaultView!.getComputedStyle(probe).color;
    }
    return { dark: doc.documentElement.classList.contains('dark'), colors };
  } finally {
    probe.remove();
  }
}

/** Only normalized numeric colors and a fixed token list may become CSS. */
export function vaultThemeCss(value: unknown): string {
  const theme = value as VaultTheme | undefined;
  if (!theme || typeof theme.dark !== 'boolean' || !theme.colors) throw new Error('Invalid vault theme');
  const declarations = VAULT_THEME_TOKENS.map(token => {
    const color = theme.colors[token];
    if (typeof color !== 'string' || !/^(?:rgba?\([\d.,%\s]+\)|(?:oklch|oklab)\([\d.eE+%/\s-]+\))$/.test(color)) throw new Error('Invalid vault theme color');
    return `--${ token }:${ color } !important`;
  });
  const aliases: Record<string, string> = {
    text:          'text-primary',
    ink:           'text-primary',
    muted:         'text-secondary',
    dim:           'text-muted',
    'read-2':      'text-secondary',
    'read-3':      'text-secondary',
    'read-4':      'text-muted',
    'read-5':      'border-strong',
    paper:         'bg-page',
    'paper-2':     'bg-surface-alt',
    card:          'bg-surface',
    'card-solid':  'bg-surface',
    surface:       'bg-surface',
    glass:         'bg-surface',
    line:          'border-default',
    'line-2':      'border-strong',
    hair:          'border-default',
    'hair-strong': 'border-strong',
    border:        'border-default',
    accent:        'accent-primary',
    'accent-2':    'accent-primary-hover',
    'accent-soft': 'bg-info',
    'accent-line': 'border-info',
    ok:            'status-success',
    success:       'status-success',
    warn:          'status-warning',
    bad:           'status-error',
    danger:        'status-error',
    'ok-soft':     'bg-success',
    'warn-soft':   'bg-warning',
    'bad-soft':    'bg-error',
    'content-bg': 'bg-page',
    'nav-bg':      'bg-surface',
    'top-bg':      'bg-header',
    'ink-05':      'border-subtle',
    'ink-08':      'border-subtle',
  };
  for (const [name, token] of Object.entries(aliases)) declarations.push(`--${ name }:var(--${ token }) !important`);
  // insertCSS adds this as one more author sheet, so the provider's own :root/body rules would win
  // on order or specificity. Every fixed declaration is !important so the theme applies reliably.
  return `:root,body{color-scheme:${ theme.dark ? 'dark' : 'light' } !important;${ declarations.join(';') };--glow-1:transparent !important;--glow-2:transparent !important}
    body{background:var(--bg-page) !important;color:var(--text-primary) !important}
    .policy-options label,.policy-detail-grid .ask-first-row,.policy-server,.ph,.vsw,.match,.otp,.save,.gen,.tabsb{background:var(--bg-surface) !important}
    .match.top{background:var(--bg-info) !important}
    .access-levels button:not(.on){background:var(--bg-surface) !important}
    .policy-choice::after,.level-radio{background:var(--bg-input) !important}
    .btn.pri,.btn.primary,.fill,.access-levels button.on{color:var(--text-on-accent) !important}`;
}
