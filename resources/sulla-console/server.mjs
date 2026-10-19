import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const host = process.env.SULLA_CONSOLE_HOST ?? '0.0.0.0';
const port = Number(process.env.SULLA_CONSOLE_PORT ?? 8786);
const root = process.env.SULLA_CONSOLE_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), 'public');
const types = new Map([['.css', 'text/css; charset=utf-8'], ['.html', 'text/html; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml']]);
const targets = {
  accounts: process.env.SULLA_CONSOLE_ACCOUNTS_URL ?? 'http://127.0.0.1:3020',
  vault: process.env.SULLA_CONSOLE_VAULT_URL ?? 'http://127.0.0.1:8787',
  files: process.env.SULLA_CONSOLE_FILES_URL ?? 'http://127.0.0.1:8792',
  projects: process.env.SULLA_CONSOLE_PROJECTS_URL ?? 'http://127.0.0.1:8793',
  agents: process.env.SULLA_CONSOLE_AGENTS_URL ?? 'http://127.0.0.1:8789',
  workflows: process.env.SULLA_CONSOLE_WORKFLOWS_URL ?? 'http://127.0.0.1:8788',
};

function headers(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function proxy(request, response, targetValue, pathname) {
  const target = new URL(targetValue);
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstream = send(target, {
    method:request.method, path:`${pathname}${new URL(request.url ?? '/', 'http://console.invalid').search}`,
    headers:{ ...request.headers, host:target.host, 'x-forwarded-host':request.headers.host ?? '', 'x-forwarded-proto':'http' },
  }, incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.setTimeout(10_000, () => upstream.destroy(new Error('upstream timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store' });
    response.end('{"error":"service_unavailable"}');
  });
  request.pipe(upstream);
}

createServer(async(request, response) => {
  headers(response);
  const url = new URL(request.url ?? '/', 'http://console.invalid');
  if (url.pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end('{"status":"ok","service":"sulla-console"}');
    return;
  }
  if (url.pathname === '/') {
    response.writeHead(308, { Location: '/console/' });
    response.end();
    return;
  }
  if (url.pathname === '/console') {
    response.writeHead(308, { Location: '/console/' });
    response.end();
    return;
  }
  if (url.pathname.startsWith('/accounts-api/v1/web/')) {
    proxy(request, response, targets.accounts, `/${url.pathname.slice('/accounts-api/'.length)}`);
    return;
  }
  if (url.pathname.startsWith('/auth/realms/sulla/') || url.pathname.startsWith('/auth/resources/')) {
    proxy(request, response, process.env.SULLA_CONSOLE_IDENTITY_URL ?? targets.accounts, url.pathname);
    return;
  }
  const serviceMatch = url.pathname.match(/^\/services\/(accounts|vault|files|projects|agents|workflows)\/(api\/)?(.*)$/);
  if (serviceMatch) {
    const [, service, api, rest] = serviceMatch;
    if ((service === 'accounts' && api) || (service === 'files' && api && /^(?:healthz$|v1\/(?:local|desktop|bootstrap|admin)(?:\/|$))/.test(rest))) {
      response.writeHead(404).end(); return;
    }
    proxy(request, response, targets[service], api ? (service === 'files' ? `/${rest}` : `/v1/${rest}`) : `/ui/${rest}`);
    return;
  }
  if (!url.pathname.startsWith('/console/')) {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end('{"error":"not_found"}');
    return;
  }
  const relative = url.pathname.slice('/console/'.length) || 'index.html';
  const candidate = normalize(join(root, relative));
  if (candidate !== root && !candidate.startsWith(`${root}/`)) {
    response.writeHead(404).end();
    return;
  }
  try {
    const metadata = await stat(candidate);
    if (!metadata.isFile()) throw new Error('not a file');
    response.writeHead(200, { 'Content-Type': types.get(extname(candidate)) ?? 'application/octet-stream' });
    createReadStream(candidate).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end('{"error":"not_found"}');
  }
}).listen(port, host, () => console.log(`Sulla Console listening on ${host}:${port}`));
