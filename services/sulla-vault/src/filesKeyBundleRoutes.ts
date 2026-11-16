// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import {
  VaultFilesKeyBundleError,
  type RegisteredFilesKeyBundle,
  type VaultFilesKeyBundleAuthority,
} from './filesKeyBundleAuthority.js';

import type { FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';

export type FilesBackupCredentialsProvider = (itemId:string,target:string)=>Promise<Record<string,string>>;

/**
 * The /v1/desktop/files router: Files service identity check, request
 * validation and the key bundle authority endpoints. Handlers moved verbatim
 * from the former createFilesKeyBundleRouter function (E9).
 */
export class FilesKeyBundleRoutes {
  constructor(
    private readonly authority:VaultFilesKeyBundleAuthority,
    private readonly identity:{ serviceId: string; token: string },
    private readonly backupCredentials?:FilesBackupCredentialsProvider,
  ) {
    if (!identity.serviceId || Buffer.byteLength(identity.token) < 32) {
      throw new Error('Vault Files service identity is not configured');
    }
  }

  router():express.Router {
    const authority = this.authority;
    const identity = this.identity;
    const backupCredentials = this.backupCredentials;
    const router = express.Router();
    router.use((request, response, next) => {
      const serviceId = request.header('x-sulla-service-id');
      // Only the "Bearer <token>" form: a bare token (no scheme) is refused.
      const token = /^Bearer\s+(.+)$/i.exec(request.header('authorization') ?? '')?.[1];
      if (serviceId !== identity.serviceId || !this.constantEqual(token, identity.token)) {
        response.status(401).json({ error: 'invalid_service_identity', message: 'Files service identity is invalid' });
        return;
      }
      next();
    });
    router.post('/backup-credentials',async(request,response,next)=>{
      try {
        if(!backupCredentials) return response.sendStatus(404);
        response.setHeader('Cache-Control','no-store');
        response.json(await backupCredentials(this.string(request.body?.itemId,'itemId',36),this.string(request.body?.target,'target',2048)));
      } catch(error) { next(error) }
    });
    router.get('/principal', async(_request, response, next) => {
      try {
        response.json(await authority.unlockedPrincipal());
      } catch (error) { next(error) }
    });
    router.post('/custody-recipient', async(request, response, next) => {
      try {
        response.json(await authority.custodyRecipient(this.context(request.body?.context)));
      } catch (error) { next(error) }
    });
    router.post('/key-bundles', async(request, response, next) => {
      try {
        const input = this.object(request.body, 'bundle');
        const bundle:RegisteredFilesKeyBundle = {
          context:        this.context(input.context),
          authorityKeyId: this.string(input.authorityKeyId, 'authorityKeyId', 1024),
          envelope:       this.object(input.envelope, 'envelope') as unknown as FilesKeyBundleEnvelope,
        };
        await authority.registerBundle(bundle);
        response.status(204).end();
      } catch (error) { next(error) }
    });
    router.post('/device-recovery', async(request, response, next) => {
      try {
        response.json(await authority.authorizeDeviceRecovery({
          context:         this.context(request.body?.context),
          devicePublicKey: this.string(request.body?.devicePublicKey, 'devicePublicKey', 1024),
        }));
      } catch (error) { next(error) }
    });
    router.use((error:unknown, _request:express.Request, response:express.Response, next:express.NextFunction) => {
      if (!(error instanceof VaultFilesKeyBundleError)) {
        next(error);
        return;
      }
      response.status(error.status).json({ error: error.code, message: error.message });
    });
    return router;
  }

  private constantEqual(actual:string | undefined, expected:string):boolean {
    if (!actual) return false;
    const left = Buffer.from(actual);
    const right = Buffer.from(expected);
    return left.byteLength === right.byteLength && timingSafeEqual(left, right);
  }

  private object(value:unknown, name:string):Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new VaultFilesKeyBundleError('invalid_request', 400, `${ name } is required`);
    }
    return value as Record<string, unknown>;
  }

  private context(value:unknown):FilesKeyBundleContext {
    const input = this.object(value, 'context');
    if (typeof input.principalId !== 'string' || !input.principalId || input.principalId.length > 512 ||
        typeof input.collectionId !== 'string' || !input.collectionId || input.collectionId.length > 512 ||
        !Number.isSafeInteger(input.keyVersion) || Number(input.keyVersion) < 1 ||
        !Number.isSafeInteger(input.epoch) || Number(input.epoch) < 1) {
      throw new VaultFilesKeyBundleError('invalid_context', 400, 'Files key bundle context is invalid');
    }
    return {
      principalId:  input.principalId,
      collectionId: input.collectionId,
      keyVersion:   Number(input.keyVersion),
      epoch:        Number(input.epoch),
    };
  }

  private string(value:unknown, name:string, max = 4096):string {
    if (typeof value !== 'string' || !value || value.length > max) {
      throw new VaultFilesKeyBundleError('invalid_request', 400, `${ name } is invalid`);
    }
    return value;
  }
}

/** @deprecated use new FilesKeyBundleRoutes(...).router() — E9 alias, removed in final cleanup */
export function createFilesKeyBundleRouter(
  authority:VaultFilesKeyBundleAuthority,
  identity:{ serviceId: string; token: string },
  backupCredentials?:FilesBackupCredentialsProvider,
):express.Router {
  return new FilesKeyBundleRoutes(authority, identity, backupCredentials).router();
}
