// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import express from 'express';

/** The local vault console (static, locked-down headers) and the closing 404 for every other /v1 path. */
export class VaultConsoleRoutes {
  /** @param consoleDirectory absolute path of services/sulla-vault/console/local */
  constructor(private readonly consoleDirectory: string) {}

  register(app: express.Express): void {
    app.get(/^\/vault$/, (_request, response) => response.redirect(308, '/vault/'));
    app.use('/vault', (_request, response, next) => {
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors app:");
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('Cache-Control', 'no-store');
      next();
    }, express.static(this.consoleDirectory));

    // Any other /v1 path is refused. The local vault never exposes wrapped keys,
    // JWT CRUD, or the retired broker credential endpoint, even to a token issued
    // before a lock. (The hosted ciphertext API moved to merchantprotocol/sulla-server.)
    app.use('/v1', (_request, response) => {
      response.status(404).json({ error: 'not_found', message: 'This API is unavailable in local vault mode' });
    });
  }
}
