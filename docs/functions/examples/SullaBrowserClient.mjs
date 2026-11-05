// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

/** Small dependency-free client that a Node function can bundle. */
export class SullaBrowserClient {
  constructor({ hostUrl = process.env.SULLA_BROWSER_HOST_URL, token = process.env.SULLA_BROWSER_TOKEN, fetchImpl = fetch } = {}) {
    if (!hostUrl || !token) throw new Error('This function was not granted spec.permissions.browser');
    this.hostUrl = hostUrl.replace(/\/$/, '');
    this.token = token;
    this.fetch = fetchImpl;
  }

  open(url) { return this.#post('/browser/open', { url }) }
  async evaluate(tabId, code) { return (await this.#post('/browser/eval', { tabId, code })).result }
  async close(tabId) { await this.#post('/browser/close', { tabId }) }

  async #post(path, body) {
    const response = await this.fetch(`${this.hostUrl}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: this.token, ...body }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(`Sulla browser request failed: ${payload.error || response.status}`);
    return payload;
  }
}
