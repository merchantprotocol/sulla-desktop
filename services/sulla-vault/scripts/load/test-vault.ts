// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { PGlite } from '@electric-sql/pglite';
import { pgcrypto } from '@electric-sql/pglite/contrib/pgcrypto';
import express from 'express';
import { readFile } from 'node:fs/promises';
import https from 'node:https';
import v8 from 'node:v8';
import type { PoolClient, QueryResult } from 'pg';

import type { VaultConfig } from '../../src/config.js';
import type { Database } from '../../src/db.js';
import { migrate } from '../../src/db.js';
import { LocalVaultAuthority } from '../../src/localAuthority.js';
import type { LocalAuthorityHost } from '../../src/localAuthority/LocalAuthorityHost.js';
import { VaultApplication } from '../../src/app.js';
import { VaultRepositories } from '../../src/repositories/VaultRepositories.js';
import { VaultProfileSessionFactory } from '../../src/profiles/VaultProfileSessionFactory.js';
import { TestOnlyUpstreamHttpClient } from './TestOnlyUpstreamHttpClient.js';
import { RequestTimingRegistry } from './RequestTimingRegistry.js';

const TEST_VAULT_HOST = '127.0.0.1';
const TEST_VAULT_PORT = 40_135;

/** Minimal pg.Pool-compatible adapter used by the service's own PGlite test strategy. */
class PglitePool {
  constructor(private readonly pglite: PGlite) {}

  async query(text: string, values?: readonly unknown[]): Promise<QueryResult> {
    const result = values?.length
      ? await this.pglite.query(text, [...values])
      : (await this.pglite.exec(text)).at(-1) ?? { rows: [], affectedRows: 0 };
    return { ...result, rowCount: result.affectedRows ?? result.rows.length } as QueryResult;
  }

  async connect(): Promise<PoolClient> {
    const client = {
      query: (text: string, values?: readonly unknown[]) => this.query(text, values),
      release: () => undefined,
    };
    return client as unknown as PoolClient;
  }

  async end(): Promise<void> { await this.pglite.close(); }
}

/** Boots the actual Express vault API over a new PGlite database and test-only egress policy. */
class TestVaultProcess {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async run(): Promise<void> {
    const dbPath = this.required('SULLA_LOAD_DB_DIR');
    const vaultCertificatePath = this.required('SULLA_LOAD_VAULT_CERT');
    const vaultPrivateKeyPath = this.required('SULLA_LOAD_VAULT_KEY');
    const upstreamCaPath = this.required('SULLA_LOAD_UPSTREAM_CA');
    const upstreamOrigin = this.required('SULLA_LOAD_UPSTREAM_ORIGIN');
    const database = new PglitePool(new PGlite(dbPath, { extensions: { pgcrypto } }));
    const requestTimings = new RequestTimingRegistry();
    const config = this.testConfig(vaultCertificatePath, vaultPrivateKeyPath);
    await migrate(database as unknown as Database);

    const repositories = new VaultRepositories(new VaultProfileSessionFactory(database as unknown as Database, false).legacy());
    const upstreamCa = await readFile(upstreamCaPath);
    const authority = new LocalVaultAuthority(
      database as unknown as Database,
      config,
      undefined,
      repositories,
      undefined,
      undefined,
      undefined,
      host => new TestOnlyUpstreamHttpClient(host as LocalAuthorityHost, upstreamOrigin, upstreamCa),
    );
    const routes = new VaultApplication(database as unknown as Database, config, { localAuthority: authority }).build();
    const app = express();
    let serverMaxConnections: number | 'unlimited' = 'unlimited';
    app.use((request, _response, next) => {
      const requestId = request.header('x-sulla-load-id');
      if (requestId) requestTimings.recordRequestReceived(requestId);
      next();
    });
    app.get('/_load/metrics', (_request, response) => response.json({
      memory: process.memoryUsage(),
      nodeVersion: process.version,
      heapSizeLimitBytes: v8.getHeapStatistics().heap_size_limit,
      nodeOptions: process.env.NODE_OPTIONS ?? '',
      outboundAgentMaxSockets: String(https.globalAgent.maxSockets),
      outboundAgentKeepAlive: https.globalAgent.keepAlive,
      uvThreadpoolSize: Number(process.env.UV_THREADPOOL_SIZE ?? 4),
      httpsServerMaxConnections: serverMaxConnections,
    }));
    app.get('/_load/timings', (_request, response) => response.json({ receivedAtNs: requestTimings.snapshot() }));
    app.use(routes);
    const server = https.createServer({
      cert: await readFile(vaultCertificatePath),
      key: await readFile(vaultPrivateKeyPath),
    }, app);
    serverMaxConnections = server.maxConnections ?? 'unlimited';

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(TEST_VAULT_PORT, TEST_VAULT_HOST, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    process.stdout.write(`${ JSON.stringify({ event: 'ready', pid: process.pid, host: TEST_VAULT_HOST, port: TEST_VAULT_PORT }) }\n`);

    const close = async() => {
      server.closeIdleConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await authority.outboundAuditSink.close();
      await database.end();
    };
    process.once('SIGTERM', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
    process.once('SIGINT', () => { void close().then(() => process.exit(0), () => process.exit(1)); });
  }

  private testConfig(certificatePath: string, privateKeyPath: string): VaultConfig {
    const brokerToken = this.required('SULLA_LOAD_BROKER_TOKEN');
    const controlToken = this.required('SULLA_LOAD_CONTROL_TOKEN');
    const approvalToken = this.required('SULLA_LOAD_APPROVAL_TOKEN');
    const filesToken = this.required('SULLA_LOAD_FILES_TOKEN');
    const bootstrapToken = this.required('SULLA_LOAD_BOOTSTRAP_TOKEN');
    const tokens = [brokerToken, controlToken, approvalToken, filesToken, bootstrapToken];
    if (new Set(tokens).size !== tokens.length || tokens.some(token => Buffer.byteLength(token) < 32)) {
      throw new Error('Harness service identities must be unique synthetic tokens of at least 32 bytes');
    }
    return {
      mode: 'desktop',
      port: TEST_VAULT_PORT,
      databaseUrl: 'postgres://synthetic-only@127.0.0.1/test-vault',
      extensionOrigins: [],
      brokerServiceId: 'sulla-tools',
      brokerServiceToken: brokerToken,
      controlServiceId: 'sulla-desktop-control',
      controlServiceToken: controlToken,
      approvalServiceId: 'sulla-desktop-approval',
      approvalServiceToken: approvalToken,
      filesServiceId: 'sulla-files',
      filesServiceToken: filesToken,
      bootstrapServiceId: 'sulla-desktop-bootstrap',
      bootstrapServiceToken: bootstrapToken,
      tlsCertificatePath: certificatePath,
      tlsPrivateKeyPath: privateKeyPath,
      humanUiOrigin: `https://${ TEST_VAULT_HOST }:${ TEST_VAULT_PORT }`,
      auditSpoolDir: this.required('SULLA_LOAD_AUDIT_DIR'),
      profileProvisioningEnabled: false,
    };
  }

  private required(name: string): string {
    const value = this.environment[name]?.trim();
    if (!value) throw new Error(`Missing synthetic harness setting: ${ name }`);
    return value;
  }
}

await new TestVaultProcess().run();
