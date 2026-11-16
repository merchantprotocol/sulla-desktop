// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import type { FilesCloudEscrowService } from '../filesCloudEscrow.js';
import type { LocalVaultAuthority } from '../localAuthority.js';
import type { VaultRequestInput } from './VaultRequestInput.js';

/** The three Desktop enrollment paths; their literals live in app.ts for the bundled-image parity check. */
export interface SullaCloudEnrollmentPaths {
  readonly wrap: string;
  readonly adopt: string;
  readonly commit: string;
}

/** Sulla Cloud session, key wraps, Desktop enrollment, recovery-key rotation and the proxied Cloud request. */
export class SullaCloudRoutes {
  constructor(
    private readonly localAuthority: LocalVaultAuthority,
    private readonly filesCloudEscrow: FilesCloudEscrowService,
    private readonly enrollmentPaths: SullaCloudEnrollmentPaths,
    private readonly input: VaultRequestInput,
  ) {}

  register(app: express.Express): void {
    const { localAuthority, filesCloudEscrow, enrollmentPaths } = this;
    const { requiredString, serviceIdentity } = this.input;

    app.put('/v1/broker/sulla-cloud/session', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.adoptSullaCloudSession(identity.serviceId, identity.token, request.body));
    });
    app.delete('/v1/broker/sulla-cloud/session', async(request, response) => {
      const identity = serviceIdentity(request);
      const result = await localAuthority.clearSullaCloudSession(identity.serviceId, identity.token);
      filesCloudEscrow.clearCloudSessionKey();
      response.json(result);
    });
    app.post('/v1/broker/sulla-cloud/account-wrap', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.rewrapForAccountPassword(identity.serviceId, identity.token, request.body));
    });
    app.post('/v1/broker/sulla-cloud/device-approval-wrap', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.wrapUserKeyForApprovedDevice(identity.serviceId, identity.token, request.body));
    });
    app.post(enrollmentPaths.wrap, async(request,response)=>{ const identity=serviceIdentity(request); response.json(await localAuthority.wrapVaultEnrollment(identity.serviceId,identity.token,request.body)); });
    app.post(enrollmentPaths.adopt, async(request,response)=>{ const identity=serviceIdentity(request); response.json(await localAuthority.adoptVaultEnrollment(identity.serviceId,identity.token,request.body)); });
    app.post(enrollmentPaths.commit, async(request,response)=>{ const identity=serviceIdentity(request); localAuthority.requireApprovalIdentity(identity.serviceId,identity.token); response.json(await localAuthority.commitVaultEnrollment(identity.serviceId,identity.token,requiredString(request.body?.requestId,'requestId'))); });
    app.post('/v1/broker/sulla-cloud/recovery-key/rotate', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.rotateAccountRecoveryKey(identity.serviceId, identity.token));
    });
    app.post('/v1/broker/sulla-cloud/request', async(request, response) => {
      const identity = serviceIdentity(request);
      response.json(await localAuthority.executeDesktopSullaCloudRequest(identity.serviceId, identity.token, request.body));
    });
  }
}
