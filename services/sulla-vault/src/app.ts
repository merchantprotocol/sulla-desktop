// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';

import { LocalVaultAuthority } from './localAuthority.js';
import { FilesAuditEmitter } from './filesAudit.js';
import { VaultFilesKeyBundleAuthority } from './filesKeyBundleAuthority.js';
import { registerCloudSyncRoutes } from './browserEnvelope/routes.js';
import { CloudVaultSyncRunner } from './browserEnvelope/syncRunner.js';
import { DomainVaultSyncCodecProvider } from './browserEnvelope/DomainVaultSyncCodecProvider.js';
import { FilesCloudEscrowService, registerFilesCloudEscrowRoute } from './filesCloudEscrow.js';
import { PostgresVaultHealthRepository } from './repositories/PostgresVaultHealthRepository.js';
import { BrokerExecutionRoutes } from './http/BrokerExecutionRoutes.js';
import { BrokerItemRoutes } from './http/BrokerItemRoutes.js';
import { DesktopControlRoutes } from './http/DesktopControlRoutes.js';
import { AuditMetadataSanitizer, HumanActivityRoutes } from './http/HumanActivityRoutes.js';
import { HumanVaultRoutes } from './http/HumanVaultRoutes.js';
import { SullaCloudRoutes } from './http/SullaCloudRoutes.js';
import { VaultConsoleRoutes } from './http/VaultConsoleRoutes.js';
import { VaultErrorHandler } from './http/VaultErrorHandler.js';
import { VaultRequestInput } from './http/VaultRequestInput.js';
import { VaultRequestPipeline } from './http/VaultRequestPipeline.js';
import { VaultRepositories } from './repositories/VaultRepositories.js';
import { VaultProfileSessionFactory } from './profiles/VaultProfileSessionFactory.js';
import type { VaultProfileSession } from './profiles/VaultProfileSession.js';

import type { VaultConfig } from './config.js';
import type { Database } from './db.js';

export interface VaultApplicationOptions { localAuthority?: LocalVaultAuthority; profileSession?: VaultProfileSession }

/**
 * Composition root of the local vault HTTP API: builds the shared authorities once and mounts
 * the request pipeline, every route group (classes under http/) and the error handler in their
 * fixed order. Order is load-bearing: CORS and body parsing first, the /v1/human origin guard
 * after human session creation, the /v1 404 and the error handler last.
 */
export class VaultApplication {
  /**
   * Desktop enrollment routes. The literals must stay in this file: the bundled-image parity
   * check (scripts/check-bundled-vault-parity.mjs) reads them from app.ts.
   */
  static readonly enrollmentPaths = {
    wrap: '/v1/broker/sulla-cloud/enrollment-wrap',
    adopt: '/v1/broker/sulla-cloud/enrollment-adopt',
    commit: '/v1/broker/sulla-cloud/enrollment-commit',
  } as const;

  constructor(
    private readonly db: Database,
    private readonly config: VaultConfig,
    private readonly options: VaultApplicationOptions = {},
  ) {}

  build(): express.Express {
    const { db, config } = this;
    const app = express();
    const domainSyncCodec = new DomainVaultSyncCodecProvider();
    const repositories = this.options.localAuthority?.vaultRepositories ?? new VaultRepositories(
      this.options.profileSession ?? new VaultProfileSessionFactory(db, config.profileProvisioningEnabled ?? false).legacy(),
    );
    const localAuthority = this.options.localAuthority ?? new LocalVaultAuthority(db, config, undefined, repositories);
    const filesKeyBundleAuthority = new VaultFilesKeyBundleAuthority(localAuthority, repositories.filesKeyBundles);
    const filesAudit = new FilesAuditEmitter(config);
    const requests = new VaultRequestInput(config);

    new VaultRequestPipeline(config).register(app);
    new DesktopControlRoutes(config, localAuthority, filesKeyBundleAuthority, new PostgresVaultHealthRepository(db), requests).register(app);
    const activity = new HumanActivityRoutes(localAuthority, repositories.humanActivity, new AuditMetadataSanitizer(), requests);
    new HumanVaultRoutes(config, localAuthority, activity, requests).register(app);
    new BrokerItemRoutes(localAuthority, requests).register(app);
    const filesCloudEscrow = new FilesCloudEscrowService({
      withUnlockedUserKey: operation => localAuthority.withUnlockedUserKey(operation),
      sullaCloudRequest: input => localAuthority.executeDesktopSullaCloudRequest(
        config.approvalServiceId ?? '', config.approvalServiceToken, input,
      ),
    }, repositories.filesCloudEscrow, filesAudit, domainSyncCodec);
    new SullaCloudRoutes(localAuthority, filesCloudEscrow, VaultApplication.enrollmentPaths, requests).register(app);
    this.mountCloudSync(app, localAuthority, filesCloudEscrow, domainSyncCodec, requests, repositories);
    new BrokerExecutionRoutes(localAuthority, requests).register(app);
    new VaultConsoleRoutes(resolve(dirname(fileURLToPath(import.meta.url)), '../console/local')).register(app);
    new VaultErrorHandler().register(app);
    return app;
  }

  /** Memory-sync/Files escrow and Passwords sync v3 routes; both are owned by their modules and gated here. */
  private mountCloudSync(
    app: express.Express,
    localAuthority: LocalVaultAuthority,
    filesCloudEscrow: FilesCloudEscrowService,
    domainSyncCodec: DomainVaultSyncCodecProvider,
    requests: VaultRequestInput,
    repositories: VaultRepositories,
  ): void {
    const { config } = this;
    const { serviceIdentity, humanCookie } = requests;
    registerFilesCloudEscrowRoute(app, filesCloudEscrow, request => {
      // Main calls with the approval service identity; Files/agents cannot invoke this route directly.
      const identity = serviceIdentity(request);
      localAuthority.requireApprovalIdentity(identity.serviceId, identity.token);
    }, request => { localAuthority.humanSessionStatus(humanCookie(request), request.header('x-csrf-token')); });
    // Passwords sync v3: the container builds/applies every body; main only signs hashes.
    registerCloudSyncRoutes(app, new CloudVaultSyncRunner(repositories.database, {
      withUnlockedUserKey: operation => localAuthority.withUnlockedUserKey(operation),
      sullaCloudRequest: input => localAuthority.executeDesktopSullaCloudRequest(
        config.approvalServiceId ?? '', config.approvalServiceToken, input,
      ),
    }, domainSyncCodec, repositories.cloudSync), request => {
      const identity = serviceIdentity(request);
      localAuthority.requireApprovalIdentity(identity.serviceId, identity.token);
    });
  }
}

/** @deprecated use VaultApplication — E9 alias, removed in final cleanup */
export function createApp(db: Database, config: VaultConfig, options: { localAuthority?: LocalVaultAuthority } = {}) {
  return new VaultApplication(db, config, options).build();
}
