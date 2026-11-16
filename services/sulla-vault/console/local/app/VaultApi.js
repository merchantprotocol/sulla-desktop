// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// The vault page's only HTTP client. Every /v1/human call carries the CSRF binding
// for the current session; the binding lives on this instance and nowhere else.
export class VaultApi {
  #csrf = '';

  constructor(fetchImpl = (...args) => globalThis.fetch(...args)) {
    this.fetchImpl = fetchImpl;
  }

  get csrf() { return this.#csrf; }

  set csrf(value) { this.#csrf = value || ''; }

  clear() { this.#csrf = ''; }

  async request(path, options = {}, responseType = 'json') {
    if (!this.#csrf) throw new Error('The vault session is missing its CSRF binding');
    const headers = new Headers(options.headers);
    headers.set('x-csrf-token', this.#csrf);
    if (options.body && !(options.body instanceof FormData)) headers.set('content-type', 'application/json');
    let response;
    try {
      response = await this.fetchImpl(path, { credentials: 'same-origin', redirect: 'error', signal: AbortSignal.timeout(30_000), ...options, headers });
    } catch (error) {
      throw new Error(error?.name === 'TimeoutError'
        ? 'The vault did not respond within 30 seconds. Make sure Sulla finished starting, then try again.'
        : 'Could not reach the vault. Make sure Sulla finished starting, then try again.');
    }
    const body = response.status === 204 ? null : responseType === 'blob' ? await response.blob() : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.message || body?.error || `Vault request failed (${response.status})`);
    return body;
  }

  // POST with a JSON body, the shape every mutating /v1/human route takes.
  post(path, payload) {
    return this.request(path, { method: 'POST', body: JSON.stringify(payload) });
  }

  revealItem(id) {
    return this.request(`/v1/human/items/${encodeURIComponent(id)}/reveal`, { method: 'POST', body: '{}' });
  }
}
