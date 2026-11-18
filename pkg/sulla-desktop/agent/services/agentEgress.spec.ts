// SPDX-License-Identifier: GPL-2.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest';

import { agentEgressLabels, prepareAgentEgress, THREAT_PROXY_START_BUDGET_MS, type AgentEgressDeps } from './agentEgress';

const CA_CHECK = 'ca-bundle.pem';

function deps(overrides: Partial<AgentEgressDeps> & { caPresent?: boolean } = {}) {
  const { caPresent = true, ...rest } = overrides;
  const d = {
    ensureAgentNetworkCommand: vi.fn(() => ['ensure-agent-network']),
    caBundlePath: '/public/ca-bundle.pem',
    agentCaTrust: vi.fn(() => ({ bind: '/public:/run/ca:ro', env: { NODE_EXTRA_CA_CERTS: '/run/ca/ca.crt', SSL_CERT_FILE: '/run/ca/ca-bundle.pem' } })),
    guestExec: vi.fn(async (args: string[]) => {
      if (args[0] === 'test' && args.at(-1)?.endsWith(CA_CHECK) && !caPresent) throw new Error('no CA');
      return { stdout: '', stderr: '' };
    }),
    egressEnforced: vi.fn(async () => true),
    proxyRunning: vi.fn(async () => true),
    applyCurrentEgressPolicy: vi.fn(async () => undefined),
    startProxy: vi.fn(async () => undefined),
    warn: vi.fn(),
    ...rest,
  };
  return d;
}

afterEach(() => vi.useRealTimers());

describe('agent launch egress', () => {
  // risk: network protection — launching an agent while the proxy is healthy must not drop everyone to direct.
  it('keeps enforced egress and attaches CA trust when the proxy is healthy and enforced', async () => {
    const d = deps();
    const egress = await prepareAgentEgress(d);
    expect(d.applyCurrentEgressPolicy).not.toHaveBeenCalled();
    expect(d.startProxy).not.toHaveBeenCalled();
    expect(egress.caPresent).toBe(true);
    expect(egress.binds).toHaveLength(1);
    expect(egress.binds[0]).toMatch(/:ro$/);
    expect(egress.env).toHaveProperty('NODE_EXTRA_CA_CERTS');
    expect(egress.env).toHaveProperty('SSL_CERT_FILE');
    expect(agentEgressLabels(egress)).toEqual({ 'sulla.threat-proxy.ca': 'present' });
  });

  // risk: availability — a down proxy must never block agent launch beyond the 5 s budget; traffic goes direct.
  it('goes direct and gives up waiting after the 5 s budget when the proxy is down', async () => {
    vi.useFakeTimers();
    const d = deps({ proxyRunning: vi.fn(async () => false), caPresent: false, startProxy: vi.fn(() => new Promise(() => undefined)) });
    let settled = false;
    const launch = prepareAgentEgress(d).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(THREAT_PROXY_START_BUDGET_MS - 500);
    expect(settled).toBe(false);
    expect(d.applyCurrentEgressPolicy).toHaveBeenCalledWith('direct');
    await vi.advanceTimersByTimeAsync(750);
    expect(settled).toBe(true);
    const egress = await launch;
    expect(egress).toEqual({ binds: [], env: {}, caPresent: false });
    expect(d.applyCurrentEgressPolicy).not.toHaveBeenCalledWith('enforced');
    expect(d.warn).toHaveBeenCalledWith(expect.stringContaining('continuing direct'), expect.any(Error));
  });

  // risk: security — without the CA bundle an agent must get no CA env or bind, and be labeled so the watcher holds direct.
  it('omits CA env and bind and labels the agent absent when the CA bundle is missing', async () => {
    vi.useFakeTimers();
    const d = deps({ caPresent: false });
    const launch = prepareAgentEgress(d);
    await vi.advanceTimersByTimeAsync(THREAT_PROXY_START_BUDGET_MS + 1_000);
    const egress = await launch;
    expect(egress.binds).toEqual([]);
    expect(egress.env).toEqual({});
    expect(agentEgressLabels(egress)).toEqual({ 'sulla.threat-proxy.ca': 'absent' });
    expect(d.applyCurrentEgressPolicy).toHaveBeenLastCalledWith('direct');
  });

  // risk: network policy — with the proxy disabled the launch must remove the redirect, not leave it enforced.
  it('applies the off policy and attaches no CA when the threat proxy is disabled', async () => {
    const d = deps({ egressEnforced: vi.fn(async () => false) });
    expect(await prepareAgentEgress(d)).toEqual({ binds: [], env: {}, caPresent: false });
    expect(d.applyCurrentEgressPolicy).toHaveBeenCalledWith('off');
    expect(d.proxyRunning).not.toHaveBeenCalled();
  });
});
