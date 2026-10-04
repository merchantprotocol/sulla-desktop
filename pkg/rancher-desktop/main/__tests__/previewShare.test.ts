/** @jest-environment node */
/* eslint-disable @typescript-eslint/require-await -- async mocks stand in for downloads, tunnels and DNS */
import http from 'node:http';
import net from 'node:net';

import { jest } from '@jest/globals';

import {
  cloudflaredReady, isLoopbackUrl, lookupPublicOrSystem, parseTunnelUrl, PreviewShareManager, SETTING_UP_MESSAGE, startGate, waitForPublicDns, type Gate,
} from '@pkg/main/previewShare';

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
      manager,
      startGate,
      startTunnel,
      gateClose,
      tunnelClose,
      tick:  (ms: number) => { clock += ms },
      touch: () => { last = clock },
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

describe('cloudflared readiness', () => {
  test('returns the binary once it is ready', async() => {
    await expect(cloudflaredReady(1_000, async() => '/bin/cloudflared')).resolves.toBe('/bin/cloudflared');
  });

  test('a slow first-run install tells the phone sharing is being set up, without brew', async() => {
    const err = await cloudflaredReady(10, () => new Promise(() => {})).catch((e: Error) => e);
    expect((err as Error).message).toBe(SETTING_UP_MESSAGE);
    expect(SETTING_UP_MESSAGE).toMatch(/^Setting up sharing…/);
    expect(SETTING_UP_MESSAGE).not.toContain('brew');
  });

  test('a failed install is reported plainly', async() => {
    await expect(cloudflaredReady(1_000, async() => { throw new Error('checksum mismatch') }))
      .rejects.toThrow("Sulla couldn't set up sharing: checksum mismatch");
  });
});

describe('waitForPublicDns', () => {
  test('retries until public resolvers answer', async() => {
    const lookup = jest.fn<(h: string) => Promise<string[]>>()
      .mockRejectedValueOnce(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }))
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(['104.16.0.1']);
    await expect(waitForPublicDns('calm-river.trycloudflare.com', 5_000, lookup, async() => {})).resolves.toBe(true);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(lookup).toHaveBeenCalledWith('calm-river.trycloudflare.com');
  });

  test('a stalled lookup cannot overrun the DNS budget', async() => {
    jest.useFakeTimers();
    try {
      const lookup = jest.fn(() => new Promise<string[]>(() => {}));
      const result = waitForPublicDns('x.trycloudflare.com', 150, lookup);
      await jest.advanceTimersByTimeAsync(150);
      await expect(result).resolves.toBe(false);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('retry sleep uses only the remaining budget', async() => {
    jest.useFakeTimers();
    try {
      const lookup = jest.fn(async() => [] as string[]);
      const result = waitForPublicDns('x.trycloudflare.com', 150, lookup);
      await jest.advanceTimersByTimeAsync(150);
      await expect(result).resolves.toBe(false);
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reports false after the deadline instead of throwing, so a working tunnel is still handed out', async() => {
    const lookup = jest.fn(async() => { throw Object.assign(new Error('queryA ETIMEOUT'), { code: 'ETIMEOUT' }) });
    await expect(waitForPublicDns('x.trycloudflare.com', 0, lookup, async() => {})).resolves.toBe(false);
  });
});

describe('lookupPublicOrSystem', () => {
  const err = (code: string) => Object.assign(new Error(code), { code });

  test('uses the public answer when public DNS is reachable', async() => {
    const system = jest.fn(async() => ['10.0.0.1']);
    await expect(lookupPublicOrSystem('a.trycloudflare.com', async() => ['104.16.0.1'], system)).resolves.toEqual(['104.16.0.1']);
    expect(system).not.toHaveBeenCalled();
  });

  test('NXDOMAIN from public DNS means not published yet, not a blocked network', async() => {
    const system = jest.fn(async() => ['10.0.0.1']);
    await expect(lookupPublicOrSystem('a.trycloudflare.com', async() => { throw err('ENOTFOUND') }, system)).rejects.toThrow('ENOTFOUND');
    expect(system).not.toHaveBeenCalled();
  });

  test.each(['ETIMEOUT', 'ECONNREFUSED', 'EREFUSED'])('falls back to the system resolver when public DNS fails with %s', async(code) => {
    const system = jest.fn(async() => ['104.16.0.1']);
    await expect(lookupPublicOrSystem('a.trycloudflare.com', async() => { throw err(code) }, system)).resolves.toEqual(['104.16.0.1']);
    expect(system).toHaveBeenCalledWith('a.trycloudflare.com');
  });

  test('a network that blocks public DNS still gets its link once the system resolver sees it', async() => {
    const system = jest.fn<(h: string) => Promise<string[]>>()
      .mockRejectedValueOnce(err('ENOTFOUND'))
      .mockResolvedValueOnce(['104.16.0.1']);
    const lookup = (h: string) => lookupPublicOrSystem(h, async() => { throw err('ETIMEOUT') }, system);
    await expect(waitForPublicDns('a.trycloudflare.com', 5_000, lookup, async() => {})).resolves.toBe(true);
  });
});

describe('PreviewShareManager rotation', () => {
  function rotationFixture() {
    let n = 0;
    let clock = 0;
    const tunnelClose = jest.fn();
    const manager = new PreviewShareManager({
      startGate:   async(target: URL) => ({ port: 4000, target, issueTicket: () => 'tk', lastUsed: () => clock, close: async() => {} }),
      startTunnel: async() => ({ publicUrl: `https://name-${ ++n }.trycloudflare.com`, close: tunnelClose }),
      now:         () => clock,
    });

    return { manager, tunnelClose, tick: (ms: number) => { clock += ms } };
  }

  test('immediate fresh retry replaces the failed hostname without waiting ten seconds', async() => {
    const { manager, tunnelClose } = rotationFixture();
    expect((await manager.open('http://localhost:5180/')).url).toContain('name-1');
    expect((await manager.open('http://localhost:5180/')).url).toContain('name-1');
    expect((await manager.open('http://localhost:5180/', { fresh: true })).url).toContain('name-2');
    expect(tunnelClose).toHaveBeenCalledTimes(1);
    await manager.closeAll();
  });

  test('simultaneous fresh requests share one new tunnel instead of killing each other', async() => {
    const { manager, tunnelClose } = rotationFixture();
    await manager.open('http://localhost:5180/');
    const [a, b] = await Promise.all([
      manager.open('http://localhost:5180/', { fresh: true }),
      manager.open('http://localhost:5180/', { fresh: true }),
    ]);
    expect(a.url).toContain('name-2');
    expect(b.url).toContain('name-2');
    expect(tunnelClose).toHaveBeenCalledTimes(1);
    // A subsequent failed lookup must be able to replace this hostname too.
    expect((await manager.open('http://localhost:5180/', { fresh: true })).url).toContain('name-3');
    expect(tunnelClose).toHaveBeenCalledTimes(2);
    await manager.closeAll();
  });
});
