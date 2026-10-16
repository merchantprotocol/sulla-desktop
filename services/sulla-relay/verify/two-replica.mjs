import jwt from 'jsonwebtoken';

import { RelayToolTunnel } from '../dist/pkg/rancher-desktop/runtime/relayTunnelClient.js';

const deviceSecret = process.env.SULLA_RELAY_DEVICE_TOKEN_SECRET;
const internalToken = process.env.SULLA_RELAY_INTERNAL_TOKEN;
const deviceId = 'acceptance-desktop';
const userId = 'acceptance-user';
const token = jwt.sign({ sub: userId, device_id: deviceId, aud: 'sulla-relay-device' }, deviceSecret, {
  algorithm: 'HS256', expiresIn: '5m',
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(url) {
  for (let attempt = 0; attempt < 50; attempt++) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`${ url } did not become healthy`);
}

await Promise.all([waitFor('http://relay1:8790/healthz'), waitFor('http://relay2:8790/healthz')]);

let cancellationObserved = false;
const tunnel = new RelayToolTunnel({
  relayUrl:      'http://relay1:8790',
  deviceToken:   token,
  deviceId:      async() => deviceId,
  currentUserId: async() => userId,
  execute:       async(ctx, _category, tool, args, signal) => {
    if (tool === 'slow') {
      await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        cancellationObserved = true;
        reject(new Error('cancelled'));
      }, { once: true }));
    }
    return { success: true, result: { args, subject: ctx.sub } };
  },
});
tunnel.start();
await delay(300);

let sequence = 0;
const context = (sub = userId, targetDevice = deviceId) => ({
  v:          1,
  iss:        'acceptance',
  aud:        'sulla-tools',
  sub,
  device_id:  targetDevice,
  scopes:     ['*'],
  iat:        Math.floor(Date.now() / 1000),
  exp:        Math.floor(Date.now() / 1000) + 60,
  jti:        `jti-${ ++sequence }`,
  request_id: `request-${ sequence }`,
});
async function call(targetDevice, tool, ctx, deadlineMs = 2_000) {
  const response = await fetch(`http://relay2:8790/v1/devices/${ targetDevice }/tools/meta/${ tool }`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${ internalToken }`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ ctx, args: { value: 42 }, deadlineMs }),
  });
  return { status: response.status, body: await response.json() };
}

const routed = await call(deviceId, 'echo', context());
if (routed.status !== 200 || routed.body.result?.result?.subject !== userId) throw new Error(`cross-replica call failed: ${ JSON.stringify(routed) }`);

const offline = await call('offline-device', 'echo', context(userId, 'offline-device'));
if (offline.status !== 503 || offline.body.error?.code !== 'DEVICE_OFFLINE') throw new Error(`offline check failed: ${ JSON.stringify(offline) }`);

const crossUser = await call(deviceId, 'echo', context('different-user'));
if (crossUser.status !== 403 || crossUser.body.error?.code !== 'FORBIDDEN') throw new Error(`cross-user check failed: ${ JSON.stringify(crossUser) }`);

const expired = await call(deviceId, 'slow', context(), 200);
await delay(100);
if (expired.status !== 504 || expired.body.error?.code !== 'DEADLINE_EXCEEDED' || !cancellationObserved) {
  throw new Error(`deadline cancellation failed: ${ JSON.stringify({ expired, cancellationObserved }) }`);
}

tunnel.stop();
console.log(JSON.stringify({ ok: true, crossReplica: true, offline: true, crossUserRejected: true, deadlineCancelled: true }));
