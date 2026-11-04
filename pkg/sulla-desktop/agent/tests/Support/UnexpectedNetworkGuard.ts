// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

class UnexpectedNetworkGuard {
  readonly fetch: typeof globalThis.fetch;

  constructor() {
    this.fetch = async input => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      throw new Error(`Unexpected real network request in agent spec: ${ target }`);
    };
  }

  install(): void { globalThis.fetch = this.fetch }
}

new UnexpectedNetworkGuard().install();
