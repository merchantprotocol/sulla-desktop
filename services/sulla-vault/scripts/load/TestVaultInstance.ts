// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomBytes } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Agent, fetch as undiciFetch } from 'undici';

export interface SyntheticServiceIdentities {
  broker: string;
  control: string;
  approval: string;
  files: string;
  bootstrap: string;
}

export interface TestVaultOptions {
  tempDir: string;
  vaultCertificatePath: string;
  vaultPrivateKeyPath: string;
  vaultCertificatePem: Buffer;
  upstreamCertificatePath: string;
  upstreamOrigin: string;
  identities: SyntheticServiceIdentities;
}

export interface TestVaultProcessStatus {
  pid: number | null;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  heapOom: boolean;
}

const TEST_VAULT_PORT = 40_135;

/** Owns the child service process, its empty PGlite store, synthetic setup API and shutdown. */
export class TestVaultInstance {
  private child?: ChildProcessWithoutNullStreams;
  private processId?: number;
  private output = '';
  private errorOutput = '';
  private exitCode: number | null = null;
  private exitSignal: NodeJS.Signals | null = null;
  private adminAgent?: Agent;
  readonly identities: SyntheticServiceIdentities;
  readonly origin = `https://127.0.0.1:${ TEST_VAULT_PORT }`;
  private readonly repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
  private readonly scriptDir = dirname(fileURLToPath(import.meta.url));

  constructor(private readonly options: TestVaultOptions) {
    this.identities = options.identities;
    this.adminAgent = new Agent({ connect: { ca: options.vaultCertificatePem } });
  }

  get pid(): number | undefined { return this.child?.pid ?? this.processId; }

  async start(): Promise<void> {
    const tsx = await this.findExecutable('tsx');
    const dbDir = resolve(this.options.tempDir, 'pglite-test-vault');
    const auditDir = resolve(this.options.tempDir, 'audit');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=256 --max-semi-space-size=2',
      UV_THREADPOOL_SIZE: '16',
      SULLA_LOAD_DB_DIR: dbDir,
      SULLA_LOAD_AUDIT_DIR: auditDir,
      SULLA_LOAD_VAULT_CERT: this.options.vaultCertificatePath,
      SULLA_LOAD_VAULT_KEY: this.options.vaultPrivateKeyPath,
      SULLA_LOAD_UPSTREAM_CA: this.options.upstreamCertificatePath,
      SULLA_LOAD_UPSTREAM_ORIGIN: this.options.upstreamOrigin,
      SULLA_LOAD_BROKER_TOKEN: this.identities.broker,
      SULLA_LOAD_CONTROL_TOKEN: this.identities.control,
      SULLA_LOAD_APPROVAL_TOKEN: this.identities.approval,
      SULLA_LOAD_FILES_TOKEN: this.identities.files,
      SULLA_LOAD_BOOTSTRAP_TOKEN: this.identities.bootstrap,
    };
    const child = spawn(tsx, [
      '--tsconfig', resolve(this.scriptDir, 'tsconfig.load.json'),
      resolve(this.scriptDir, 'test-vault.ts'),
    ], { cwd: this.repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    this.processId = child.pid;
    child.stdout.on('data', chunk => { this.output = (this.output + chunk.toString()).slice(-64_000); });
    child.stderr.on('data', chunk => { this.errorOutput = (this.errorOutput + chunk.toString()).slice(-64_000); });
    child.once('exit', (code, signal) => { this.exitCode = code; this.exitSignal = signal; });
    await this.waitForReady(child);
  }

  async provisionSyntheticCredential(): Promise<{ principalId: string }> {
    const api = new TestVaultSetupApi(this.origin, this.options.vaultCertificatePem);
    try {
      const principalId = await api.createUserAndCredential(this.identities);
      return { principalId };
    } finally {
      await api.close();
    }
  }

  async readMetrics(): Promise<Record<string, unknown>> {
    return this.readTestRoute('/_load/metrics');
  }

  async readRequestTimings(): Promise<Record<string, string>> {
    try {
      const response = await this.readTestRoute('/_load/timings');
      return response.receivedAtNs as Record<string, string>;
    } catch (error) {
      if (this.child?.exitCode !== null && this.child?.exitCode !== undefined) return {};
      throw error;
    }
  }

  async status(): Promise<TestVaultProcessStatus> {
    return {
      pid: this.pid ?? null,
      exitCode: this.exitCode,
      signal: this.exitSignal,
      heapOom: /heap out of memory|allocation failed - javascript heap out of memory/i.test(this.errorOutput),
    };
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (this.adminAgent) {
      await this.adminAgent.close().catch(() => undefined);
      this.adminAgent = undefined;
    }
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGTERM');
    const stopped = await this.waitForExit(child, 5_000);
    if (!stopped) {
      child.kill('SIGKILL');
      await this.waitForExit(child, 2_000);
    }
  }

  private async readTestRoute(pathname: string): Promise<Record<string, unknown>> {
    const response = await undiciFetch(`${ this.origin }${ pathname }`, {
      dispatcher: this.adminAgent as never,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Synthetic vault telemetry returned HTTP ${ response.status }`);
    return await response.json() as Record<string, unknown>;
  }

  private async waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
    await new Promise<void>((resolveReady, reject) => {
      let seen = this.output;
      const timeout = setTimeout(() => reject(new Error(`Synthetic vault did not become ready. ${ this.safeDiagnostics() }`)), 30_000);
      timeout.unref?.();
      const inspect = () => {
        const lines = this.output.slice(seen.length);
        seen = this.output;
        for (const line of lines.split('\n')) {
          if (!line.includes('"event":"ready"')) continue;
          clearTimeout(timeout);
          resolveReady();
          return;
        }
      };
      child.stdout.on('data', inspect);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', (code, signal) => {
        clearTimeout(timeout);
        if (code === 0) reject(new Error('Synthetic vault exited before readiness'));
        else reject(new Error(`Synthetic vault exited before readiness (${ code ?? signal }). ${ this.safeDiagnostics() }`));
      });
      inspect();
    });
  }

  private async waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<boolean> {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return new Promise(resolveExit => {
      const timer = setTimeout(() => { child.removeListener('exit', finish); resolveExit(false); }, timeoutMs);
      timer.unref?.();
      const finish = () => { clearTimeout(timer); resolveExit(true); };
      child.once('exit', finish);
    });
  }

  private async findExecutable(name: string): Promise<string> {
    const candidates = [
      resolve(this.repoRoot, 'node_modules/.bin', name),
      resolve(this.repoRoot, 'services/sulla-vault/node_modules/.bin', name),
    ];
    for (const candidate of candidates) {
      try { await access(candidate); return candidate; } catch { /* try next location */ }
    }
    throw new Error(`Missing ${ name }; install the repository dependencies before running the vault load harness`);
  }

  private safeDiagnostics(): string {
    const tail = `${ this.output }\n${ this.errorOutput }`.slice(-2_000);
    return tail.replaceAll(this.identities.broker, '[synthetic token]').replaceAll(this.identities.control, '[synthetic token]')
      .replaceAll(this.identities.approval, '[synthetic token]').replaceAll(this.identities.files, '[synthetic token]')
      .replaceAll(this.identities.bootstrap, '[synthetic token]');
  }
}

/** Creates/unlocks the empty test vault and adds its only provider item through the public API. */
class TestVaultSetupApi {
  private readonly agent: Agent;

  constructor(private readonly origin: string, vaultCertificate: Buffer) {
    // Keep setup's short-lived TLS connections separate from the agent used by
    // telemetry; closing setup must not break the later metrics sampler.
    this.agent = new Agent({ connect: { ca: vaultCertificate } });
  }

  async createUserAndCredential(identities: SyntheticServiceIdentities): Promise<string> {
    const control = this.serviceHeaders('sulla-desktop-control', identities.control);
    const session = (await this.request('/v1/human/session', {
      method: 'POST', headers: control, body: '{}',
    })).body;
    const grantUrl = new URL(session.url as string);
    const grant = new URLSearchParams(grantUrl.hash.slice(1));
    const csrf = String(session.csrf);
    const exchangeResponse = await this.request('/v1/human/session/exchange', {
      method: 'POST',
      headers: { ...control, origin: this.origin },
      body: JSON.stringify({ grant: grant.get('grant'), csrf }),
    });
    const exchange = exchangeResponse.body;
    let cookie = exchangeResponse.cookie;
    if (!cookie) throw new Error('Synthetic vault session exchange did not set a cookie');
    let csrfToken = String(exchange.csrf);
    const unlockedResponse = await this.request('/v1/human/unlock', {
      method: 'POST',
      headers: { cookie, origin: this.origin, 'x-csrf-token': csrfToken },
      body: JSON.stringify({ password: randomBytes(24).toString('base64url') }),
    });
    cookie = unlockedResponse.cookie ?? cookie;
    csrfToken = String(unlockedResponse.body.csrf ?? csrfToken);

    const status = (await this.request('/v1/desktop/status', { method: 'GET', headers: control })).body;
    const principalId = String(status.principalId ?? '');
    if (!principalId) throw new Error('Synthetic vault did not return the unlocked test principal');
    const approval = this.serviceHeaders('sulla-desktop-approval', identities.approval);
    await this.request('/v1/broker/integrations/openai/desktop-account', {
      method: 'PUT',
      headers: approval,
      body: JSON.stringify({
        accountId: 'synthetic-load',
        label: 'Synthetic load test account',
        connected: true,
        values: { api_key: 'synthetic-load-api-key' },
      }),
    });
    await this.allowSyntheticAgentForCredential(cookie, csrfToken);
    return principalId;
  }

  async close(): Promise<void> { await this.agent.close(); }

  private async request(path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ body: Record<string, unknown>; cookie?: string }> {
    const response = await undiciFetch(`${ this.origin }${ path }`, {
      ...init,
      dispatcher: this.agent as never,
      headers: { 'content-type': 'application/json', ...init.headers },
    });
    if (!response.ok) throw new Error(`Synthetic vault setup ${ path } returned HTTP ${ response.status }`);
    const rawCookie = response.headers.get('set-cookie');
    const cookie = rawCookie?.split(';', 1)[0];
    const body = response.status === 204 ? {} : await response.json() as Record<string, unknown>;
    return { body, ...(cookie ? { cookie } : {}) };
  }

  private serviceHeaders(serviceId: string, token: string): Record<string, string> {
    return { 'x-sulla-service-id': serviceId, authorization: `Bearer ${ token }` };
  }

  private async allowSyntheticAgentForCredential(cookie: string, csrfToken: string): Promise<void> {
    const humanHeaders = { cookie, origin: this.origin, 'x-csrf-token': csrfToken };
    const listed = await this.request('/v1/human/items', { method: 'GET', headers: humanHeaders });
    const items = Array.isArray(listed.body.items) ? listed.body.items as Array<Record<string, unknown>> : [];
    const account = items.find(item => {
      const integration = item.integration as { integrationId?: unknown; accountId?: unknown } | undefined;
      return integration?.integrationId === 'openai' && integration.accountId === 'synthetic-load';
    });
    const itemId = String(account?.id ?? '');
    const revision = Number(account?.revision);
    if (!itemId || !Number.isSafeInteger(revision) || revision < 1) {
      throw new Error('Synthetic API-key item was not visible through the human vault API');
    }
    const revealed = await this.request(`/v1/human/items/${ encodeURIComponent(itemId) }/reveal`, {
      method: 'POST', headers: humanHeaders, body: '{}',
    });
    const item = revealed.body.item as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') throw new Error('Synthetic API-key item could not be revealed through the test session');
    const previousPolicy = item.agentPolicy as Record<string, unknown> | undefined;
    item.agentPolicy = {
      ...previousPolicy,
      mode: 'agents',
      level: 'autofill',
      agents: ['load-harness-agent'],
      sites: ['api.openai.com'],
      expiresAt: null,
      askFirst: false,
      allowServerAgents: false,
    };
    await this.request(`/v1/human/items/${ encodeURIComponent(itemId) }`, {
      method: 'PATCH',
      headers: humanHeaders,
      body: JSON.stringify({ revision, item }),
    });
  }

}
