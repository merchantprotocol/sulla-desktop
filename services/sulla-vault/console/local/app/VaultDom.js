// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { Icons } from './VaultFormat.js';

// Thin DOM access for the views, plus the page's status line and shared widgets.
export class VaultDom {
  constructor(document) {
    this.document = document;
  }

  byId(id) { return this.document.getElementById(id); }

  all(selector) { return this.document.querySelectorAll(selector); }

  create(tag) { return this.document.createElement(tag); }

  message(text, error = false) {
    const output = this.byId('vault-message');
    output.textContent = text;
    output.classList.toggle('error', error);
    if (text) setTimeout(() => { if (output.textContent === text) output.textContent = ''; }, 4_000);
  }

  iconButton(path, label, className = '') {
    const button = this.create('button'); button.type = 'button'; button.className = className; button.innerHTML = Icons.icon(path); button.setAttribute('aria-label', label); button.title = label; return button;
  }

  async copyValue(value) {
    try { await navigator.clipboard.writeText(value); this.message('Copied.'); } catch { this.message('Copy is unavailable in this window.', true); }
  }

  // Disables a form's submit button with a progress label; returns the restore callback.
  busy(form, label) {
    const button = form.querySelector('button[type="submit"], button:not([type])');
    const original = button?.textContent;
    if (button) { button.disabled = true; button.textContent = label; }
    return () => { if (button) { button.disabled = false; button.textContent = original; } };
  }

  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob); const anchor = this.create('a'); anchor.href = url; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
