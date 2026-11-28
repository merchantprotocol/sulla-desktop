// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { Agent, fetch as undiciFetch } from 'undici';

import type { SyntheticServiceIdentities } from './TestVaultInstance.js';

export interface ProbeResult { elapsedMs: number; status: number; failed: boolean }

/** Short health, integration-credential metadata and buffered broker/execute probes. */
export class VaultProbeClient {
  private readonly agent: Agent;

  constructor(
    private readonly origin: string,
    private readonly syntheticUpstreamOrigin: string,
    private readonly principalId: string,
    private readonly identities: SyntheticServiceIdentities,
    vaultCertificate: Buffer,
  ) {
    if (new URL(origin).port === '30135') throw new Error('Refusing to probe the real vault port');
    this.agent = new Agent({ connect: { ca: vaultCertificate }, connections: 64 });
  }

  async runGroup(kind: 'credentialLookup' | 'brokerExecute' | 'health', count: number): Promise<ProbeResult[]> {
    return Promise.all(Array.from({ length: count }, () => this.runOne(kind)));
  }

  async close(): Promise<void> { await this.agent.close(); }

  private async runOne(kind: 'credentialLookup' | 'brokerExecute' | 'health'): Promise<ProbeResult> {
    const startedAt = process.hrtime.bigint();
    let status = 0;
    let failed = false;
    const id = randomUUID();
    try {
      const commonHeaders = {
        'x-sulla-service-id': 'sulla-tools',
        authorization: `Bearer ${ this.identities.broker }`,
      };
      let path = '/healthz';
      let method = 'GET';
      let headers: Record<string, string> = {};
      let body: string | undefined;
      if (kind === 'credentialLookup') {
        path = '/v1/broker/integrations/openai/metadata?accountId=synthetic-load';
        headers = commonHeaders;
      } else if (kind === 'brokerExecute') {
        path = '/v1/broker/execute';
        method = 'POST';
        headers = { ...commonHeaders, 'content-type': 'application/json' };
        body = JSON.stringify({
          claims: {
            sub: this.principalId,
            agent_id: 'load-harness-agent',
            pod_id: 'load-harness-pod',
            credential_scope: { integration_id: 'openai', account_id: 'synthetic-load' },
          },
          operation: 'provider.discovery',
          ref: { integrationId: 'openai', accountId: 'synthetic-load' },
          url: `${ this.syntheticUpstreamOrigin }/v1/models`,
          method: 'GET',
          headers: { 'x-sulla-load-id': id, 'x-synthetic-load-mode': 'short' },
          injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
          responseType: 'json',
        });
      }
      const response = await undiciFetch(`${ this.origin }${ path }`, {
        method,
        headers,
        ...(body ? { body } : {}),
        dispatcher: this.agent as never,
      });
      status = response.status;
      failed = !response.ok;
      await response.arrayBuffer();
    } catch {
      failed = true;
    }
    return { elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000, status, failed };
  }
}
