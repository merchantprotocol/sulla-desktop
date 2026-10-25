// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// The vault origin: vault.<host> serves only WP-A's vault-origin build
// (browser-dist) and /cloud-vault-sync/*, with the CSP and headers from
// Sulla Cloud's vault-origin `_headers`. Every other Vault route answers 404
// on that hostname, and the vault page is never served on any other hostname,
// so nothing else on the server shares the origin that receives the vault
// password.

import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';

import { onVaultHost } from './session.js';

import type { BrowserSyncConfig } from './config.js';
import type { NextFunction, Request, Response } from 'express';

export const VAULT_ORIGIN_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self'",
    "connect-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "manifest-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "require-trusted-types-for 'script'",
    'trusted-types default',
  ].join('; '),
  'Strict-Transport-Security':    'max-age=31536000; includeSubDomains',
  'Referrer-Policy':              'no-referrer',
  'Cache-Control':                'no-store',
  'Cross-Origin-Opener-Policy':   'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Content-Type-Options':       'nosniff',
  'X-Frame-Options':              'DENY',
  'Permissions-Policy':           [
    'accelerometer=()', 'autoplay=()', 'camera=()', 'display-capture=()', 'geolocation=()', 'gyroscope=()', 'hid=()',
    'magnetometer=()', 'microphone=()', 'midi=()', 'payment=()', 'publickey-credentials-get=()', 'serial=()', 'usb=()',
    'clipboard-read=()', 'clipboard-write=(self)',
  ].join(', '),
});

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html':  'text/html; charset=utf-8',
  '.js':    'text/javascript; charset=utf-8',
  '.mjs':   'text/javascript; charset=utf-8',
  '.css':   'text/css; charset=utf-8',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.ico':   'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff':  'font/woff',
  '.wasm':  'application/wasm',
});

// Console screens the vault page links to with relative hrefs go back to the console.
const DASHBOARD_ROUTES = new Set([
  'index', 'chat', 'files', 'editor', 'workflows', 'workflow-run', 'agents', 'use-cases', 'organizations',
  'org-settings',
]);

// The build leaves this token in passwords.html; the console URL is a runtime value.
const DASHBOARD_PLACEHOLDER = '__SULLA_DASHBOARD_ORIGIN__';
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** A file inside the dist directory for a URL path, or null for anything hidden, odd or outside it. */
function distFile(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const segments = decoded.split('/').filter(Boolean);
  // `_headers`, `_redirects` and dotfiles are build metadata, never content.
  if (!segments.length || segments.some(segment => !SEGMENT.test(segment))) return null;
  if (!CONTENT_TYPES[extname(decoded).toLowerCase()]) return null;
  const file = resolve(root, ...segments);
  return file.startsWith(`${ root }${ sep }`) ? file : null;
}

export function createVaultOrigin(config: BrowserSyncConfig) {
  const root = resolve(config.distDirectory);
  return async(request: Request, response: Response, next: NextFunction): Promise<void> => {
    if (!onVaultHost(config, request)) {
      next();
      return;
    }
    for (const [name, value] of Object.entries(VAULT_ORIGIN_HEADERS)) response.setHeader(name, value);
    const api = request.path === '/cloud-vault-sync' || request.path.startsWith('/cloud-vault-sync/');
    if (api || request.path === '/healthz') {
      next();
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    if (request.path === '/') {
      response.redirect(302, '/passwords.html');
      return;
    }
    const page = /^\/([a-z-]+)(?:\.html)?$/.exec(request.path)?.[1];
    if (page && DASHBOARD_ROUTES.has(page) && config.dashboardOrigin) {
      response.redirect(302, new URL(`${ page }.html`, config.dashboardOrigin).href);
      return;
    }
    const file = distFile(root, request.path);
    if (!file) {
      response.status(404).json({ error: 'not_found' });
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      let body: Buffer | string = await readFile(file);
      if (extname(file) === '.html') {
        body = body.toString('utf8').replaceAll(DASHBOARD_PLACEHOLDER, escapeAttribute(config.dashboardOrigin));
      }
      response.setHeader('Content-Type', CONTENT_TYPES[extname(file).toLowerCase()]);
      response.status(200).send(body);
    } catch {
      response.status(404).json({ error: 'not_found' });
    }
  };
}
