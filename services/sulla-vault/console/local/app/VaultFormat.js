// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Pure formatting and policy helpers. No DOM access and no state.
export class VaultFormat {
  static esc(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  static defaultPolicy() {
    return { mode: 'only_me', level: 'metadata', agents: [], sites: [], expiresAt: null, askFirst: false, allowServerAgents: false };
  }

  static policy(item) { return { ...VaultFormat.defaultPolicy(), ...(item?.agentPolicy || {}) }; }

  static entries(value) { return value.split(',').map(entry => entry.trim()).filter(Boolean); }

  static sites(value) { return VaultFormat.entries(value).map(entry => entry.toLowerCase()); }

  // Two-letter tile initials as in the approved design: GitHub → GH, HubSpot → HS, Stripe secret key → ST.
  static initials(item) {
    const word = (item?.name || item?.integration?.integrationId || '').match(/[\p{L}\p{N}]+/u)?.[0] || '--';
    const inner = word.slice(1).match(/\p{Lu}/u)?.[0];
    return (word[0] + (inner || word[1] || '')).toUpperCase();
  }

  // Stable per-item tile tint (vault.css .tile, .tile.c2 … .tile.c5).
  static tileTint(item) {
    let hash = 0;
    for (const character of String(item?.id || item?.name || '')) hash = (hash * 31 + character.codePointAt(0)) >>> 0;
    return hash % 5 ? ` c${ hash % 5 + 1 }` : '';
  }

  static typeLabel(type) {
    return ({ login: 'Login', apiKey: 'API key', card: 'Card', note: 'Secure note', identity: 'Identity' })[type] || type || 'Item';
  }

  static dateText(value) {
    return value ? new Date(value).toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'Never';
  }

  static localDateValue(value) {
    if (!value) return '';
    const date = new Date(value);
    const offset = date.getTimezoneOffset();
    return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 16);
  }

  static text(value, max = 4_000) { return typeof value === 'string' ? value.slice(0, max) : ''; }

  // 32 random bytes as unpadded base64url; the caller shows it once.
  static newRecoveryCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const code = btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    bytes.fill(0);
    return code;
  }
}

export class Icons {
  static levelBars = '<span class="bars" aria-hidden="true"><i></i><i></i><i></i></span>';
  static lock = '<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="11" rx="2.5"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>';
  static agent = '<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24"><rect x="5" y="7" width="14" height="12" rx="3"></rect><path d="M9 4v3m6-3v3M8 12h.01M12 12h.01M16 12h.01M9 16h6"></path></svg>';
  static eyePath = '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>';
  static copyPath = '<rect x="8" y="8" width="12" height="12" rx="2.5"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8"/>';

  static icon(path) { return `<svg class="i sm" aria-hidden="true" viewBox="0 0 24 24">${path}</svg>`; }
}
