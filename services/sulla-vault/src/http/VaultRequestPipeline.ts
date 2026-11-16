// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import express from 'express';

import type { VaultConfig } from '../config.js';

/** The app-wide front of the vault: extension CORS (and preflight answers), then JSON body parsing. */
export class VaultRequestPipeline {
  constructor(private readonly config: VaultConfig) {}

  register(app: express.Express): void {
    const config = this.config;
    app.disable('x-powered-by');
    app.use((request, response, next) => {
      const origin = request.header('origin');
      const allowed = Boolean(origin && (origin.startsWith('chrome-extension://') || config.extensionOrigins.includes(origin)));
      if (allowed) {
        response.setHeader('Access-Control-Allow-Origin', origin as string);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Sulla-Accounts-Authorization, X-Sulla-Accounts-Authority-Id, X-Sulla-Authority-Id, X-Sulla-Organization-Id');
        response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
        response.setHeader('Access-Control-Allow-Credentials', 'true');
      }
      if (request.method === 'OPTIONS') { response.status(allowed ? 204 : 403).end(); return; }
      next();
    });
    app.use(express.json({ limit: '36mb' }));
  }
}
