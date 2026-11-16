// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// What Desktop told the page when it opened it, read once from the launch URL.
export class LaunchContext {
  constructor(href) {
    const initialUrl = new URL(href);
    this.integrationHint = initialUrl.searchParams.get('integration');
    this.accountHint = initialUrl.searchParams.get('account');
    this.filesRestore = initialUrl.searchParams.get('restoreFiles') === '1';
    this.connectSpec = LaunchContext.parseConnectSpec(initialUrl.hash);
  }

  // Desktop passes the integration's public form (field labels, hints, setup notes) in the
  // fragment so a new connection gets a guided screen. It holds no secrets.
  static parseConnectSpec(hash) {
    try {
      const raw = new URLSearchParams(hash.slice(1)).get('connect');
      if (!raw) return null;
      const spec = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(raw.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0))));
      return spec && typeof spec === 'object' && Array.isArray(spec.fields) ? spec : null;
    } catch { return null; }
  }
}
