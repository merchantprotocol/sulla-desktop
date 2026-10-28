// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License 1.0. See LICENSES/Sulla-Fair-Code-1.0.txt.

import { readFile } from 'node:fs/promises';
import { X509Certificate } from 'node:crypto';

import type { Router } from 'express';

import { adminRoute } from './common.js';
import { hostname } from './overview.js';
import type { RouteContext } from '../routes/helpers.js';

async function certificate(path: string | undefined): Promise<{ expiresAt: string } | null> {
  if (!path) return null;
  try {
    const cert = new X509Certificate(await readFile(path));
    return { expiresAt: new Date(cert.validTo).toISOString() };
  } catch {
    return null;
  }
}

export function registerDomainsRoutes(router: Router, _context: RouteContext): void {
  router.get('/server/v1/domains', adminRoute(async(_request, response) => {
    const host = hostname();
    const cert = await certificate(process.env.SULLA_TLS_CERTIFICATE_PATH
      ?? process.env.SULLA_TLS_CERT_CONTAINER_PATH);
    response.json({
      host,
      vaultHost: process.env.SULLA_VAULT_HOST ?? (host ? `vault.${host}` : ''),
      relayUrl: host ? `wss://${host}/relay` : '',
      relayConnected: null,
      certificate: cert,
      vaultCertificate: cert,
      letsEncrypt: Boolean(cert),
      network: {
        lan: null,
        public: null,
        allowedRanges: [],
        available: false,
        reason: 'Network settings are managed by the installer.',
      },
    });
  }));
}
