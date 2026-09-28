/** @jest-environment node */
import http from 'node:http';
import net from 'node:net';

import { jest } from '@jest/globals';

import { isLoopbackUrl, parseTunnelUrl, PreviewShareManager, startGate, type Gate } from '@pkg/main/previewShare';

let upstream: http.Server;
let upstreamPort: number;
const seen: http.IncomingHttpHeaders[] = [];
const upgraded = new Set<import('node:stream').Duplex>();

beforeAll(async() => {
  upstream = http.createServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/redirect') {
      res.writeHead(302, { location: `http://localhost:${ upstreamPort }/after` });

      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(`app:${ req.url }`);
  });
  upstream.on('upgrade', (req, socket) => {
    upgraded.add(socket);
    seen.push(req.headers);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', d => socket.write(`echo:${ d }`));
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
  upstreamPort = (upstream.address() as net.AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => {
  upstream.close(() => r());
  upstream.closeAllConnections();
  for (const socket of upgraded) socket.destroy();
}));

function get(port: number, path: string, cookie?: string) {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers: cookie ? { cookie } : {} }, (res) => {
      let body = '';
      res.on('data', c => (body += c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body }));
    }).on('error', reject);
  });
}

async function enter(gate: Gate, next = '/') {
  const res = await get(gate.port, `/__sulla_preview/enter?t=${ gate.issueTicket() }&next=${ encodeURIComponent(next) }`);
  const cookie = String(res.headers['set-cookie']?.[0] || '').split(';')[0];

  return { res, cookie };
}

describe('startGate', () => {
  let gate: Gate;
  beforeEach(async() => {
    gate = await startGate(new URL(`http://localhost:${ upstreamPort }`));
  });
  afterEach(() => gate.close());

  test('refuses requests without the share cookie', async() => {
    const res = await get(gate.port, '/');
    expect(res.status).toBe(401);
    expect(res.body).toContain('expired');
  });

  test('a ticket trades once for the cookie, then the app is proxied with its own Host', async() => {
    const ticket = gate.issueTicket();
    const first = await get(gate.port, `/__sulla_preview/enter?t=${ ticket }&next=%2Fdash%3Fx%3D1`);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe('/dash?x=1');
    const cookie = String(first.headers['set-cookie']?.[0]).split(';')[0];
    expect(String(first.headers['set-cookie']?.[0])).toMatch(/HttpOnly; Secure; SameSite=Lax/);

    expect((await get(gate.port, `/__sulla_preview/enter?t=${ ticket }`)).status).toBe(401);

    const page = await get(gate.port, '/dash?x=1', `${ cookie }; theirs=1`);
    expect(page.status).toBe(200);
    expect(page.body).toBe('app:/dash?x=1');
    const headers = seen[seen.length - 1];
    expect(headers.host).toBe(`localhost:${ upstreamPort }`);
    expect(headers.cookie).toBe('theirs=1');
  });

  test('rejects a forged cookie and off-site next targets', async() => {
    expect((await get(gate.port, '/', '__sulla_preview=nope')).status).toBe(401);
    const { res } = await enter(gate, '//evil.example/x');
    expect(res.headers.location).toBe('/');
  });

  test('rewrites absolute redirects back to localhost into relative ones', async() => {
    const { cookie } = await enter(gate);
    const res = await get(gate.port, '/redirect', cookie);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/after');
  });

  test('expired tickets are refused', async() => {
    let clock = 1_000;
    const timed = await startGate(new URL(`http://localhost:${ upstreamPort }`), () => clock);
    const ticket = timed.issueTicket();
    clock += 6 * 60_000;
    expect((await get(timed.port, `/__sulla_preview/enter?t=${ ticket }`)).status).toBe(401);
    await timed.close();
  });

  test('proxies WebSocket upgrades only for cookie holders', async() => {
    const { cookie } = await enter(gate);
    const talk = (withCookie: boolean) => new Promise<string>((resolve) => {
      const sock = net.connect(gate.port, '127.0.0.1', () => {
        sock.write(`GET /hmr HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${ withCookie ? `Cookie: ${ cookie }\r\n` : '' }\r\n`);
      });
      let out = '';
      sock.on('data', (d) => {
        out += d;
        if (out.includes('101') && !out.includes('echo')) sock.write('hi');
        if (out.includes('echo:hi') || out.includes('401')) {
          sock.destroy();
          resolve(out);
        }
      });
      sock.on('close', () => resolve(out));
    });
    expect(await talk(false)).toContain('401');
    const ok = await talk(true);
    expect(ok).toContain('101 Switching Protocols');
    expect(ok).toContain('echo:hi');
  });
});

describe('helpers', () => {
  test('isLoopbackUrl only accepts local http(s)', () => {
    expect(isLoopbackUrl('http://localhost:6152/')).toBe(true);
    expect(isLoopbackUrl('http://127.0.0.1:8080/x')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:3000/')).toBe(true);
    expect(isLoopbackUrl('http://app.localhost:3000/')).toBe(true);
    expect(isLoopbackUrl('https://example.com/')).toBe(false);
    expect(isLoopbackUrl('http://192.168.1.10/')).toBe(false);
    expect(isLoopbackUrl('file:///tmp/x.html')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });

  test('parseTunnelUrl finds the quick-tunnel hostname in cloudflared logs', () => {
    const log = '2026-09-28T21:00:00Z INF |  https://calm-river-abc123.trycloudflare.com                  |';
    expect(parseTunnelUrl(log)).toBe('https://calm-river-abc123.trycloudflare.com');
    expect(parseTunnelUrl('INF Requesting new quick Tunnel on trycloudflare.com...')).toBeNull();
  });
});

describe('PreviewShareManager', () => {
  function fakes() {
    let clock = 0;
    let last = 0;
    const gateClose = jest.fn(async() => {});
    const tunnelClose = jest.fn();
    const startGate = jest.fn(async(target: URL) => ({
      port: 4000, target, issueTicket: () => `tk${ Math.random() }`, lastUsed: () => last, close: gateClose,
    }));
    const startTunnel = jest.fn(async() => ({ publicUrl: 'https://abc.trycloudflare.com', close: tunnelClose }));
    const manager = new PreviewShareManager({ startGate, startTunnel, now: () => clock });

    return {
      manager, startGate, startTunnel, gateClose, tunnelClose,
      tick: (ms: number) => { clock += ms; },
      touch: () => { last = clock; },
    };
  }

  test('reuses one tunnel per local origin and deep-links the path', async() => {
    const f = fakes();
    const a = await f.manager.open('http://localhost:6152/admin?tab=2');
    await f.manager.open('http://localhost:6152/other');
    expect(f.startTunnel).toHaveBeenCalledTimes(1);
    expect(a.url).toMatch(/^https:\/\/abc\.trycloudflare\.com\/__sulla_preview\/enter\?t=.+&next=%2Fadmin%3Ftab%3D2$/);
    await f.manager.open('http://localhost:9000/');
    expect(f.startTunnel).toHaveBeenCalledTimes(2);
    await f.manager.closeAll();
  });

  test('refuses non-local targets', async() => {
    const f = fakes();
    await expect(f.manager.open('https://example.com/')).rejects.toThrow('Only local links');
    expect(f.startGate).not.toHaveBeenCalled();
  });

  test('a failed tunnel closes the gate and can be retried', async() => {
    const f = fakes();
    f.startTunnel.mockRejectedValueOnce(new Error('cloudflared is not installed'));
    await expect(f.manager.open('http://localhost:6152/')).rejects.toThrow('not installed');
    expect(f.gateClose).toHaveBeenCalledTimes(1);
    await expect(f.manager.open('http://localhost:6152/')).resolves.toHaveProperty('url');
    await f.manager.closeAll();
  });

  test('idle shares shut down; active ones stay up', async() => {
    const f = fakes();
    await f.manager.open('http://localhost:6152/');
    f.tick(20 * 60_000);
    f.touch();
    await f.manager.sweepIdle();
    expect(f.tunnelClose).not.toHaveBeenCalled();
    f.tick(31 * 60_000);
    await f.manager.sweepIdle();
    expect(f.tunnelClose).toHaveBeenCalledTimes(1);
    expect(f.gateClose).toHaveBeenCalledTimes(1);
    await f.manager.closeAll();
  });
});
