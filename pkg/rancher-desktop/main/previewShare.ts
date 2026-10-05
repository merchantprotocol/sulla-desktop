// previewShare.ts — open a local web app (a Docker container's published
// port, a dev server, a mockup server) from Sulla Mobile or Sulla Cloud.
//
// The phone can't reach `localhost:6152` on this Mac, so for each local
// origin we run:
//
//   phone ──https──▶ Cloudflare Quick Tunnel ──▶ gate (127.0.0.1:random) ──▶ localhost:<port>
//
// Quick Tunnel URLs are public to anyone holding them, so the gate refuses
// every request that doesn't carry this share's secret cookie. The only way
// to get the cookie is a single-use, short-lived ticket that Desktop hands
// to the owner over the authenticated relay (`bookmarks.open`). Shares shut
// themselves down after sitting idle.

import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { Resolver } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { ensureCloudflared } from '@pkg/main/cloudflaredBinary';
import Logging from '@pkg/utils/logging';

const console = Logging.background;

const COOKIE = '__sulla_preview';
const ENTER_PATH = '/__sulla_preview/enter';
const TICKET_TTL_MS = 5 * 60_000;
const IDLE_TTL_MS = 30 * 60_000;
// Sulla Mobile gives `bookmarks.open` 60s. Install, tunnel start and the DNS
// wait share this budget, leaving 10s for Docker discovery and 5s for relay overhead.
const OPEN_BUDGET_MS = 45_000;
// A first-run cloudflared download gets this long before we tell the phone
// to come back shortly.
const INSTALL_WAIT_MS = 20_000;
const PUBLIC_DNS_TIMEOUT_MS = 15_000;
const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'];
export const SETTING_UP_MESSAGE = 'Setting up sharing… Sulla Desktop is installing its secure tunnel (one time only). Try again in a few seconds.';
const TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** True for http(s) URLs that only resolve on this machine. */
export function isLoopbackUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();

  return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost');
}

export function parseTunnelUrl(output: string): string | null {
  return TUNNEL_URL.exec(output)?.[0] ?? null;
}

function token(): string {
  return randomBytes(24).toString('base64url');
}

function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);

  return x.length === y.length && timingSafeEqual(x, y);
}

function readCookie(header: string | undefined, name: string): string | null {
  for (const part of (header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }

  return null;
}

/** The request's Cookie header minus our own cookie — the app never sees it. */
function stripCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header.split(';').filter(p => p.split('=')[0].trim() !== COOKIE).join(';').trim();

  return kept || undefined;
}

/** Keep only same-origin relative paths so `next` can't redirect off-site. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function denied(res: http.ServerResponse): void {
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Preview closed</title>' +
    '<p style="font:16px system-ui;padding:24px">This Sulla preview link has expired. Open the bookmark again from Sulla.</p>');
}

export interface Gate {
  port:        number;
  target:      URL;
  /** Mint a single-use ticket that trades for this gate's cookie. */
  issueTicket: () => string;
  lastUsed:    () => number;
  close:       () => Promise<void>;
}

/**
 * A loopback reverse proxy in front of `target` that only lets through
 * holders of its secret cookie. Handles plain HTTP and WebSocket upgrades
 * (dev-server hot reload).
 */
export async function startGate(target: URL, now: () => number = Date.now): Promise<Gate> {
  const secret = token();
  const tickets = new Map<string, number>();
  const targetPort = Number(target.port) || (target.protocol === 'https:' ? 443 : 80);
  const targetHost = target.hostname.replace(/^\[|\]$/g, '');
  const transport = target.protocol === 'https:' ? https : http;
  let lastUsed = now();
  // Upgraded (WebSocket) connections leave the HTTP server's bookkeeping, so
  // track them to tear them down on close.
  const tunnels = new Set<() => void>();

  const authorized = (req: http.IncomingMessage) => {
    const cookie = readCookie(req.headers.cookie, COOKIE);

    return !!cookie && sameSecret(cookie, secret);
  };

  const forwardHeaders = (req: http.IncomingMessage) => {
    const headers = { ...req.headers, host: target.host };
    const cookie = stripCookie(req.headers.cookie);
    if (cookie) headers.cookie = cookie;
    else delete headers.cookie;

    return headers;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://gate');

    if (url.pathname === ENTER_PATH) {
      const ticket = url.searchParams.get('t') || '';
      const expires = tickets.get(ticket);
      tickets.delete(ticket);
      if (!expires || expires < now()) return denied(res);
      lastUsed = now();
      res.writeHead(302, {
        location:        safeNext(url.searchParams.get('next')),
        'set-cookie':    `${ COOKIE }=${ secret }; Path=/; HttpOnly; Secure; SameSite=Lax`,
        'cache-control': 'no-store',
      });

      return res.end();
    }

    if (!authorized(req)) return denied(res);
    lastUsed = now();

    const upstream = transport.request({
      host:               targetHost,
      port:               targetPort,
      method:             req.method,
      path:               req.url,
      headers:            forwardHeaders(req),
      rejectUnauthorized: false, // local dev servers use self-signed certs
    }, (up) => {
      const headers = { ...up.headers };
      // Absolute redirects back to localhost would send the phone nowhere.
      const location = headers.location;
      if (typeof location === 'string' && location.startsWith(target.origin)) {
        headers.location = location.slice(target.origin.length) || '/';
      }
      res.writeHead(up.statusCode || 502, headers);
      up.pipe(res);
    });
    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`Sulla couldn't reach ${ target.host }: ${ err.message }`);
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req, socket, head) => {
    if (!authorized(req)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');

      return;
    }
    lastUsed = now();
    const upstream = net.connect(targetPort, targetHost, () => {
      const headers = forwardHeaders(req);
      const lines = [`${ req.method } ${ req.url } HTTP/1.1`];
      for (const [key, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) {
          if (v !== undefined) lines.push(`${ key }: ${ v }`);
        }
      }
      upstream.write(`${ lines.join('\r\n') }\r\n\r\n`);
      if (head?.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    const drop = () => {
      tunnels.delete(drop);
      socket.destroy();
      upstream.destroy();
    };
    tunnels.add(drop);
    for (const s of [upstream, socket]) {
      s.on('error', drop);
      s.on('close', drop);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  return {
    port: (server.address() as net.AddressInfo).port,
    target,
    issueTicket: () => {
      const ticket = token();
      tickets.set(ticket, now() + TICKET_TTL_MS);

      return ticket;
    },
    lastUsed: () => lastUsed,
    close:    () => new Promise<void>((resolve) => {
      for (const drop of [...tunnels]) drop();
      server.close(() => resolve());
      server.closeAllConnections?.();
    }),
  };
}

/**
 * cloudflared's path, installing Sulla's pinned copy when the Mac has none.
 * A first-run download that outlasts `waitMs` keeps going in the background
 * while the caller gets SETTING_UP_MESSAGE to retry.
 */
export async function cloudflaredReady(
  waitMs = INSTALL_WAIT_MS,
  ensure: () => Promise<string> = ensureCloudflared,
): Promise<string> {
  const install = ensure();
  let timer: NodeJS.Timeout | undefined;
  const slow = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(SETTING_UP_MESSAGE)), waitMs);
    timer.unref?.();
  });
  install.catch(() => { /* surfaced below, or by the next attempt */ });
  try {
    return await Promise.race([install, slow]);
  } catch (err) {
    if ((err as Error).message === SETTING_UP_MESSAGE) throw err;
    throw new Error(`Sulla couldn't set up sharing: ${ (err as Error).message }`);
  } finally {
    clearTimeout(timer);
  }
}

// Answers that mean "this resolver works, the record just isn't there yet".
const NOT_PUBLISHED = new Set(['ENOTFOUND', 'ENODATA']);

export type DnsLookup = (host: string) => Promise<string[]>;

/**
 * Ask 1.1.1.1/8.8.8.8 first (what a phone on cellular sees). On networks that
 * block outbound public DNS, those fail with timeouts/refusals rather than
 * NXDOMAIN, so fall back to the Mac's own resolvers instead of concluding the
 * record doesn't exist.
 */
export async function lookupPublicOrSystem(
  host: string,
  publicLookup: DnsLookup = (h) => {
    const resolver = new Resolver({ timeout: 2_000, tries: 1 });
    resolver.setServers(PUBLIC_RESOLVERS);

    return resolver.resolve4(h);
  },
  systemLookup: DnsLookup = h => new Resolver({ timeout: 2_000, tries: 1 }).resolve4(h),
): Promise<string[]> {
  try {
    return await publicLookup(host);
  } catch (err) {
    if (NOT_PUBLISHED.has((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }

  return systemLookup(host);
}

/**
 * Best-effort wait until DNS answers for `hostname`. A phone that asks before
 * the record exists caches the NXDOMAIN (up to 30 minutes), so the link is
 * held back while the record propagates. Returns false if it never showed
 * up in time; the tunnel itself is registered and working, so the caller
 * hands the link out anyway rather than killing a good share.
 */
export async function waitForPublicDns(
  hostname: string,
  timeoutMs = PUBLIC_DNS_TIMEOUT_MS,
  lookup: DnsLookup = lookupPublicOrSystem,
  sleep: (ms: number) => Promise<void> = ms => new Promise((resolve) => { setTimeout(resolve, ms) }),
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let timer: NodeJS.Timeout | undefined;
    try {
      const answer = await Promise.race([
        lookup(hostname),
        new Promise<string[]>((resolve) => {
          timer = setTimeout(() => resolve([]), Math.max(0, deadline - Date.now()));
        }),
      ]);
      if (answer.length && Date.now() < deadline) return true;
    } catch { /* not published yet, or no resolver reachable */ } finally {
      clearTimeout(timer);
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(1_000, remaining));
  }

  return false;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface Tunnel {
  publicUrl: string;
  close:     () => void;
}

/**
 * Start a Cloudflare Quick Tunnel to `localPort` and resolve once Cloudflare
 * reports a registered connection. (Handing out the hostname before that
 * risks the phone caching a failed DNS lookup for up to 30 minutes.)
 */
export async function startQuickTunnel(localPort: number, budgetMs = OPEN_BUDGET_MS): Promise<Tunnel> {
  const deadline = Date.now() + budgetMs;
  const binary = await cloudflaredReady(Math.min(INSTALL_WAIT_MS, budgetMs));
  const metricsPort = await freePort();
  const child: ChildProcess = spawn(binary, [
    'tunnel', '--no-autoupdate',
    '--metrics', `127.0.0.1:${ metricsPort }`,
    '--url', `http://127.0.0.1:${ localPort }`,
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  const close = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
  };

  try {
    const publicUrl = await new Promise<string>((resolve, reject) => {
      let output = '';
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-20_000);
        const found = parseTunnelUrl(output);
        if (found) {
          child.stdout?.off('data', onData);
          child.stderr?.off('data', onData);
          resolve(found);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('error', (err: NodeJS.ErrnoException) => reject(err.code === 'ENOENT'
        ? new Error(`Sulla couldn't start its secure tunnel (${ binary } is missing). Try again to reinstall it.`)
        : err));
      child.once('exit', code => reject(new Error(`cloudflared exited (${ code }) before the tunnel came up: ${ output.trim().slice(-300) }`)));
      setTimeout(() => reject(new Error('Timed out starting the Cloudflare tunnel')), Math.max(0, deadline - Date.now())).unref?.();
    });

    for (;;) {
      if (child.exitCode !== null) throw new Error('cloudflared exited before the tunnel was ready');
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for the Cloudflare tunnel to register');
      try {
        const ready = await fetch(`http://127.0.0.1:${ metricsPort }/ready`, { signal: AbortSignal.timeout(remaining) });
        if (ready.ok && ((await ready.json()) as { readyConnections?: number }).readyConnections) break;
      } catch { /* metrics server not up yet */ }
      if (Date.now() > deadline) throw new Error('Timed out waiting for the Cloudflare tunnel to register');
      await new Promise(r => setTimeout(r, Math.min(500, Math.max(0, deadline - Date.now()))));
    }
    const hostname = new URL(publicUrl).hostname;
    if (!await waitForPublicDns(hostname, Math.min(PUBLIC_DNS_TIMEOUT_MS, Math.max(0, deadline - Date.now())))) {
      console.warn(`[previewShare] ${ hostname } isn't visible in DNS yet; handing it out anyway`);
    }
    // Drain output so a full pipe can never stall cloudflared.
    child.stdout?.resume();
    child.stderr?.resume();

    return { publicUrl, close };
  } catch (err) {
    close();
    throw err;
  }
}

interface Share {
  gate:    Gate;
  tunnel:  Tunnel;
}

export interface OpenedPreview {
  url:       string;
  /** The ticket inside `url` stops working after this (the share itself lives on while in use). */
  expiresAt: string;
}

export interface PreviewShareDeps {
  startGate:   (target: URL) => Promise<Gate>;
  startTunnel: (localPort: number) => Promise<Tunnel>;
  now:         () => number;
}

export class PreviewShareManager {
  private shares = new Map<string, Promise<Share>>();
  private settled = new WeakSet<Promise<Share>>();
  private sweeper: NodeJS.Timeout | null = null;

  constructor(private deps: PreviewShareDeps = { startGate, startTunnel: startQuickTunnel, now: Date.now }) {}

  /**
   * Returns a single-use public link that lands on `targetUrl`. `fresh`
   * replaces the origin's tunnel with a new hostname — for a phone that has
   * already cached a failed lookup of the old one. A share that is still
   * starting is already a new hostname, so concurrent
   * fresh requests join it instead of tearing it down under each other.
   */
  async open(targetUrl: string, opts: { fresh?: boolean } = {}): Promise<OpenedPreview> {
    if (!isLoopbackUrl(targetUrl)) throw new Error('Only local links can be shared through a preview tunnel');
    const target = new URL(targetUrl);
    if (opts.fresh) await this.rotate(target.origin);
    const share = await this.shareFor(target.origin);
    const ticket = share.gate.issueTicket();
    const next = `${ target.pathname }${ target.search }${ target.hash }`;

    return {
      url:       `${ share.tunnel.publicUrl }${ ENTER_PATH }?t=${ encodeURIComponent(ticket) }&next=${ encodeURIComponent(next) }`,
      expiresAt: new Date(this.deps.now() + TICKET_TTL_MS).toISOString(),
    };
  }

  private shareFor(origin: string): Promise<Share> {
    let pending = this.shares.get(origin);
    if (!pending) {
      pending = (async() => {
        const gate = await this.deps.startGate(new URL(origin));
        try {
          const tunnel = await this.deps.startTunnel(gate.port);
          console.log(`[previewShare] sharing ${ origin } at ${ tunnel.publicUrl }`);

          return { gate, tunnel };
        } catch (err) {
          await gate.close();
          throw err;
        }
      })();
      const created = pending;
      created.then(() => this.settled.add(created), () => {
        if (this.shares.get(origin) === created) this.shares.delete(origin);
      });
      this.shares.set(origin, pending);
      this.ensureSweeper();
    }

    return pending;
  }

  private async rotate(origin: string): Promise<void> {
    const pending = this.shares.get(origin);
    if (!pending || !this.settled.has(pending)) return;
    await pending.catch(() => null);
    // Another request may have rotated it while we looked.
    if (this.shares.get(origin) === pending) await this.close(origin);
  }

  private ensureSweeper(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => void this.sweepIdle(), 60_000);
    this.sweeper.unref?.();
  }

  async sweepIdle(): Promise<void> {
    for (const [origin, pending] of this.shares) {
      const share = await pending.catch(() => null);
      if (share && this.deps.now() - share.gate.lastUsed() > IDLE_TTL_MS) {
        await this.close(origin);
      }
    }
  }

  async close(origin: string): Promise<void> {
    const pending = this.shares.get(origin);
    this.shares.delete(origin);
    const share = await pending?.catch(() => null);
    if (!share) return;
    share.tunnel.close();
    await share.gate.close();
    console.log(`[previewShare] closed ${ origin }`);
  }

  async closeAll(): Promise<void> {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
    await Promise.all([...this.shares.keys()].map(origin => this.close(origin)));
  }
}

export const previewShares = new PreviewShareManager();
