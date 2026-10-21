import { createReadStream, readFileSync } from 'node:fs';
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
  vault: process.env.SULLA_CONSOLE_VAULT_URL ?? 'https://127.0.0.1:30135',
  files: process.env.SULLA_CONSOLE_FILES_URL ?? 'https://127.0.0.1:30124',
  agents: process.env.SULLA_CONSOLE_AGENTS_URL ?? 'http://127.0.0.1:8789',
  workflows: process.env.SULLA_CONSOLE_WORKFLOWS_URL ?? 'http://127.0.0.1:30122',
};
const tlsCaFiles = {
  vault: process.env.SULLA_CONSOLE_VAULT_CA_FILE,
  files: process.env.SULLA_CONSOLE_FILES_CA_FILE,
};

function publicOrigin(request) {
  // A reverse proxy must configure its externally visible origin. Client-supplied
  // forwarding headers are untrusted and never determine the browser's origin.
  const configured = process.env.SULLA_CONSOLE_PUBLIC_ORIGIN;
  const authority = request.headers.host;
  if (!configured && (typeof authority !== 'string' || !/^[\[\]A-Za-z0-9.:-]+$/.test(authority))) throw new Error('invalid host');
  const origin = new URL(configured ?? `http://${authority}`);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('invalid public origin');
  return origin;
}

function headers(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; frame-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'; form-action 'none'");
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function proxy(request, response, targetValue, pathname, service) {
  let target, origin, ca;
  try {
    target = new URL(targetValue);
    origin = publicOrigin(request);
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('invalid upstream');
    if (target.protocol === 'https:' && tlsCaFiles[service]) ca = readFileSync(tlsCaFiles[service]);
  } catch {
    response.writeHead(502, { 'Content-Type':'application/json; charset=utf-8' });
    response.end('{"error":"service_unavailable"}');
    return;
  }
  const send = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([name]) =>
    name !== 'host' && name !== 'forwarded' && !name.startsWith('x-forwarded-')));
  const upstream = send(target, {
    method:request.method, path:`${pathname}${new URL(request.url ?? '/', 'http://console.invalid').search}`,
    ca,
    headers:{ ...headers, host:origin.host, 'x-forwarded-host':origin.host, 'x-forwarded-proto':origin.protocol.slice(0, -1) },
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
    proxy(request, response, targets.accounts, `/${url.pathname.slice('/accounts-api/'.length)}`, 'accounts');
    return;
  }
  if (url.pathname.startsWith('/auth/realms/sulla/') || url.pathname.startsWith('/auth/resources/')) {
    proxy(request, response, process.env.SULLA_CONSOLE_IDENTITY_URL ?? targets.accounts, url.pathname, 'accounts');
    return;
  }
  const serviceMatch = url.pathname.match(/^\/services\/(accounts|vault|files|agents|workflows)\/(api\/)?(.*)$/);
  if (serviceMatch) {
    const [, service, api, rest] = serviceMatch;
    if ((service === 'accounts' && api) || (service === 'files' && api && /^(?:healthz$|v1\/(?:local|desktop|bootstrap|admin)(?:\/|$))/.test(rest))) {
      response.writeHead(404).end(); return;
    }
    proxy(request, response, targets[service], api ? (service === 'files' ? `/${rest}` : `/v1/${rest}`) : `/ui/${rest}`, service);
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
