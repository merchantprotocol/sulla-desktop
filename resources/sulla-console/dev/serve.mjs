// Copyright © 2026 Merchant Protocol, LLC. All rights reserved.
// Licensed under the Sulla Fair-Code License. See LICENSE.

// Development server for the Sulla Server console pages. Not part of any image.
//
//   node resources/sulla-console/dev/serve.mjs --mock                      synthetic data, no backend
//   node resources/sulla-console/dev/serve.mjs --proxy http://127.0.0.1:18788   a running server stack
//
// Console:      http://127.0.0.1:<port>/console/     (resources/sulla-console/public)
// Vault origin: http://127.0.0.1:<vault-port>/       (services/sulla-vault/browser-dist)
//
// Both send the Content-Security-Policy the server sends, so CSP violations show up here first.
// --mock injects dev/mock-api.js ahead of every page script and fakes the Keycloak sign-in
// redirect. --proxy forwards /api and /accounts-api to the stack instead; sign in on the stack's
// own address first (cookies are per host, not per port, so the session carries over).

import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const publicDir = path.resolve(here, '../public');
const vaultDir = path.join(root, 'services/sulla-vault/browser-dist');

// The console's policy. Scripts stay 'self'; styles allow inline style attributes, which Cloud's
// screens use for meters, widths and colours.
export const CONSOLE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
};

function parseArgs(argv) {
  const args = { mock: false, port: 8790, vaultPort: 8791, host: '127.0.0.1', proxy: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock') args.mock = true;
    else if (a === '--port') args.port = Number(argv[++i]);
    else if (a === '--vault-port') args.vaultPort = Number(argv[++i]);
    else if (a === '--host') args.host = argv[++i];
    else if (a === '--proxy') args.proxy = new URL(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.mock && !args.proxy) throw new Error('Pass --mock, or --proxy <server URL>.');
  return args;
}

const args = parseArgs(process.argv.slice(2));
const consoleUrl = `http://${args.host}:${args.port}/console`;
const vaultOrigin = `http://${args.host}:${args.vaultPort}`;

function safeJoin(base, urlPath) {
  const file = path.resolve(base, `.${decodeURIComponent(urlPath)}`);
  return file === base || file.startsWith(`${base}${path.sep}`) ? file : null;
}

function sendFile(res, file, headers, transform) {
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
    res.end('Not found');
    return;
  }
  const type = TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers });
  if (transform && type.startsWith('text/html')) res.end(transform(readFileSync(file, 'utf8')));
  else createReadStream(file).pipe(res);
}

function proxy(req, res, target) {
  const url = new URL(req.url, target);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = { ...req.headers, host: target.host };
  const upstream = send(url, { method: req.method, headers }, (up) => {
    res.writeHead(up.statusCode || 502, up.headers);
    up.pipe(res);
  });
  upstream.on('error', (error) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`Proxy error: ${error.message}`);
  });
  req.pipe(upstream);
}

// ── Console origin ──────────────────────────────────────────────────────
function consolePage(html) {
  const vaultMeta = `<meta name="sulla-vault-origin" content="${vaultOrigin}">`;
  let out = html.replace('<meta name="sulla-vault-origin" content="">', vaultMeta);
  if (args.mock) {
    const hostMeta = '<meta name="sulla-server-host" content="sulla.northwind.co">';
    out = out
      .replace('<meta name="sulla-server-host" content="">', hostMeta)
      // Before the first script, after the meta tags (mock-api reads <meta name="sulla-mock">).
      .replace('<script', '<script src="/console-dev/mock-api.js"></script>\n<script');
  }
  return out;
}

const consoleHeaders = {
  'Content-Security-Policy': CONSOLE_CSP,
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
};

function consoleHandler(req, res) {
  const url = new URL(req.url, consoleUrl);
  if (args.proxy && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/accounts-api/'))) {
    proxy(req, res, args.proxy);
    return;
  }
  if (args.mock && url.pathname === '/accounts-api/v1/web/login') {
    // Stands in for Keycloak: "signs in" and returns to the console page that asked.
    const back = url.searchParams.get('returnTo') || '/console/';
    const location = back.startsWith('/console') ? back : '/console/';
    res.writeHead(302, { Location: location, 'Set-Cookie': 'sulla-console-csrf=mock-csrf; Path=/; SameSite=Lax' });
    res.end();
    return;
  }
  if (url.pathname === '/' || url.pathname === '/console') {
    res.writeHead(302, { Location: '/console/' });
    res.end();
    return;
  }
  if (url.pathname.startsWith('/console-dev/')) {
    sendFile(res, safeJoin(here, url.pathname.slice('/console-dev'.length)), consoleHeaders);
    return;
  }
  if (url.pathname.startsWith('/console/')) {
    let rel = url.pathname.slice('/console'.length);
    if (rel.endsWith('/')) rel += 'index.html';
    // The sign-in card spec renders like a console page in --mock mode.
    const file = args.mock && rel === '/sign-in.html' ? path.join(here, 'sign-in.html') : safeJoin(publicDir, rel);
    sendFile(res, file, consoleHeaders, consolePage);
    return;
  }
  sendFile(res, null, consoleHeaders);
}

// ── Vault origin ────────────────────────────────────────────────────────
// The build's _headers and _redirects are Cloudflare Pages files; apply them the same way.
function vaultHeaders() {
  const headers = {};
  const file = path.join(vaultDir, '_headers');
  if (!existsSync(file)) return headers;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s{2}([A-Za-z-]+):\s*(.+)$/.exec(line);
    if (m && m[1] !== 'Strict-Transport-Security') headers[m[1]] = m[2];
  }
  return headers;
}

function vaultRedirects() {
  const file = path.join(vaultDir, '_redirects');
  if (!existsSync(file)) return new Map();
  return new Map(readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => line.split(/\s+/))
    .map(([from, to]) => [from, to.replace('{{SULLA_CONSOLE_URL}}', consoleUrl)]));
}

function vaultPage(html) {
  let out = html.replace('{{SULLA_CONSOLE_URL}}', consoleUrl);
  if (args.mock) {
    const mock = '<script src="/vault-dev/mock-api.js"></script>\n'
      + '<script src="/vault-dev/vault-fixture.js"></script>\n'
      + '<script src="/vault-dev/vault-shared-fixture.js"></script>\n';
    const meta = '<meta name="sulla-server-host" content="vault.sulla.northwind.co">\n';
    const first = '<script src="/js/cloud/passwords/tt-policy.js"';
    out = out.replace(first, `${meta}${mock}${first}`);
  }
  return out;
}

function vaultHandler(req, res) {
  const url = new URL(req.url, vaultOrigin);
  const headers = vaultHeaders();
  const redirect = vaultRedirects().get(url.pathname);
  if (redirect) {
    res.writeHead(302, { Location: redirect });
    res.end();
    return;
  }
  if (args.mock && url.pathname.startsWith('/vault-dev/')) {
    sendFile(res, safeJoin(here, url.pathname.slice('/vault-dev'.length)), headers);
    return;
  }
  if (args.proxy && (url.pathname.startsWith('/cloud-vault-sync/') || url.pathname.startsWith('/files-sync/'))) {
    proxy(req, res, args.proxy);
    return;
  }
  sendFile(res, safeJoin(vaultDir, url.pathname), headers, vaultPage);
}

createServer(consoleHandler).listen(args.port, args.host, () => {
  console.log(`console       ${consoleUrl}/${args.mock ? '   (mock data)' : `   (proxy ${args.proxy.origin})`}`);
});
createServer(vaultHandler).listen(args.vaultPort, args.host, () => {
  console.log(`vault origin  ${vaultOrigin}/`);
});
