// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';
import type { DesktopVaultTransport } from '../../../../pkg/sulla-desktop/vault-broker/desktopTransport.js';
import type { SyntheticServiceIdentities } from './TestVaultInstance.js';

export interface StreamRequestOptions {
  id?: string;
  holdSeconds: number;
  body: Record<string, unknown>;
  cancelAfterHeaders?: boolean;
}

export interface StreamHeaderResult {
  id: string;
  elapsedMs: number | null;
  status: number | null;
  canceled: boolean;
  failed: boolean;
  failureKind?: string;
  failureDetail?: string;
}

export interface StreamCallOutcome extends StreamHeaderResult {
  receivedBytes: number;
}

/** Opaque synthetic stream request using the real DesktopVaultTransport Node/undici implementation. */
export class DesktopStreamClient {
  private transport?: DesktopVaultTransport;

  constructor(
    private readonly vaultOrigin: string,
    private readonly syntheticUpstreamOrigin: string,
    private readonly principalId: string,
    private readonly identities: SyntheticServiceIdentities,
  ) {
    if (new URL(vaultOrigin).port === '30135') throw new Error('Refusing to use the real vault port');
  }

  async create(): Promise<void> {
    process.env.SULLA_INSTANCE = 'firstrun-test';
    delete process.env.SULLA_VAULT_STREAM_TRANSPORT;
    if (!process.argv.includes('--sulla-test-instance')) process.argv.push('--sulla-test-instance');
    const { vaultTlsPins } = await import('../../../../pkg/sulla-desktop/main/vaultTls.js');
    Object.assign(globalThis, {
      // Electron's main process supplies require; this narrowly maps the one
      // module DesktopVaultTransport loads synchronously from its TLS callback.
      require: (specifier: string) => {
        if (specifier !== '@pkg/main/vaultTls') throw new Error(`Unexpected require in harness: ${ specifier }`);
        return { vaultTlsPins };
      },
    });
    const { DesktopVaultIdentityRepository, DesktopVaultTransport } = await import('../../../../pkg/sulla-desktop/vault-broker/desktopTransport.js');
    const electronMustNotBeUsed = () => { throw new Error('Unexpected Electron session path in synthetic stream test'); };
    // The default dispatcher is intentional: it proves the repo's actual
    // undici Agent cap and TLS-pin connector rather than a harness-made substitute.
    this.transport = new DesktopVaultTransport(new DesktopVaultIdentityRepository(), electronMustNotBeUsed as never);
  }

  open(options: StreamRequestOptions): StreamCall {
    if (!this.transport) throw new Error('Desktop stream client was not initialized');
    return new StreamCall(this.transport, this.vaultOrigin, this.syntheticUpstreamOrigin, this.principalId, this.identities, options);
  }

  async close(): Promise<void> {
    // DesktopVaultTransport does not expose lifecycle shutdown because it is
    // process-wide in production. The harness owns this instance and closes
    // its private default Agent to prove sockets are returned.
    if (!this.transport) return;
    const internal = this.transport as unknown as { nodeStreamDispatcher?: { close(): Promise<void> } };
    await internal.nodeStreamDispatcher?.close();
  }
}

/** One independently abortable fetchStream request, separating header timing from body lifetime. */
export class StreamCall {
  readonly id: string;
  readonly headers: Promise<StreamHeaderResult>;
  readonly done: Promise<StreamCallOutcome>;
  private readonly controller = new AbortController();
  private resolveHeaders!: (value: StreamHeaderResult) => void;

  constructor(
    private readonly transport: DesktopVaultTransport,
    private readonly vaultOrigin: string,
    private readonly syntheticUpstreamOrigin: string,
    private readonly principalId: string,
    private readonly identities: SyntheticServiceIdentities,
    private readonly options: StreamRequestOptions,
  ) {
    this.id = options.id ?? randomUUID();
    this.headers = new Promise(resolve => { this.resolveHeaders = resolve; });
    this.done = this.run();
  }

  abort(): void { this.controller.abort(); }

  private async run(): Promise<StreamCallOutcome> {
    const startedAt = process.hrtime.bigint();
    let headerResult: StreamHeaderResult = { id: this.id, elapsedMs: null, status: null, canceled: false, failed: false };
    let receivedBytes = 0;
    try {
      const request = {
        claims: {
          sub: this.principalId,
          agent_id: 'load-harness-agent',
          pod_id: 'load-harness-pod',
          credential_scope: { integration_id: 'openai', account_id: 'synthetic-load' },
        },
        operation: 'provider.cli',
        ref: { integrationId: 'openai', accountId: 'synthetic-load' },
        url: `${ this.syntheticUpstreamOrigin }/v1/responses`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'text/event-stream',
          'x-sulla-load-id': this.id,
          'x-synthetic-load-mode': 'stream',
          'x-synthetic-hold-seconds': String(this.options.holdSeconds),
        },
        body: this.options.body,
        injections: [{ field: 'api_key', target: 'header', name: 'authorization', scheme: 'Bearer' }],
        responseType: 'stream',
      };
      const response = await this.transport.fetchStream(`${ this.vaultOrigin }/v1/broker/execute-stream`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-sulla-load-id': this.id,
          'x-sulla-service-id': 'sulla-tools',
          authorization: `Bearer ${ this.identities.broker }`,
        },
        body: JSON.stringify(request),
        signal: this.controller.signal,
      });
      headerResult = {
        id: this.id,
        elapsedMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
        status: response.status,
        canceled: false,
        failed: !response.ok,
      };
      if (!response.ok) {
        let failureKind = response.headers.get('x-sulla-vault-error') ?? undefined;
        let failureDetail: string | undefined;
        if (response.body) {
          try {
            const body = await response.clone().json() as { error?: unknown; message?: unknown };
            if (!failureKind && typeof body.error === 'string') failureKind = body.error;
            if (typeof body.message === 'string') failureDetail = body.message.slice(0, 300);
          } catch { /* no JSON error code */ }
        }
        if (failureKind) headerResult.failureKind = failureKind;
        if (failureDetail) headerResult.failureDetail = failureDetail;
      }
      this.resolveHeaders(headerResult);
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        return { ...headerResult, receivedBytes };
      }
      if (this.options.cancelAfterHeaders) {
        await response.body.cancel().catch(() => undefined);
        return { ...headerResult, receivedBytes };
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          receivedBytes += next.value.byteLength;
        }
      } finally {
        reader.releaseLock();
      }
      return { ...headerResult, receivedBytes };
    } catch (error) {
      const canceled = this.controller.signal.aborted;
      const failure = error as Error & { code?: unknown; cause?: { code?: unknown; message?: unknown } };
      const failureKind = canceled ? undefined : String(failure.cause?.code ?? failure.code ?? failure.name ?? 'UnknownError');
      let failureDetail = canceled ? undefined : `${ failure.message ?? 'Unknown error' }${ failure.cause?.message ? `; cause=${ String(failure.cause.message) }` : '' }`;
      if (failureDetail) {
        for (const token of Object.values(this.identities)) failureDetail = failureDetail.split(token).join('[synthetic token]');
        failureDetail = failureDetail.replaceAll('synthetic-load-api-key', '[synthetic key]');
      }
      headerResult = {
        ...headerResult,
        canceled,
        failed: !canceled,
        ...(failureKind ? { failureKind } : {}),
        ...(failureDetail ? { failureDetail: failureDetail.slice(0, 300) } : {}),
      };
      this.resolveHeaders(headerResult);
      return { ...headerResult, receivedBytes };
    }
  }
}
