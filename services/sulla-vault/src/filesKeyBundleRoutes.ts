import { timingSafeEqual } from 'node:crypto';

import express from 'express';

import {
  VaultFilesKeyBundleError,
  type RegisteredFilesKeyBundle,
  type VaultFilesKeyBundleAuthority,
} from './filesKeyBundleAuthority.js';

import type { FilesKeyBundleContext, FilesKeyBundleEnvelope } from '@sulla/vault-crypto';

function constantEqual(actual:string | undefined, expected:string):boolean {
  if (!actual) return false;
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.byteLength === right.byteLength && timingSafeEqual(left, right);
}

function object(value:unknown, name:string):Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new VaultFilesKeyBundleError('invalid_request', 400, `${ name } is required`);
  }
  return value as Record<string, unknown>;
}

function context(value:unknown):FilesKeyBundleContext {
  const input = object(value, 'context');
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

function string(value:unknown, name:string, max = 4096):string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new VaultFilesKeyBundleError('invalid_request', 400, `${ name } is invalid`);
  }
  return value;
}

export function createFilesKeyBundleRouter(
  authority:VaultFilesKeyBundleAuthority,
  identity:{ serviceId: string; token: string },
):express.Router {
  if (!identity.serviceId || Buffer.byteLength(identity.token) < 32) {
    throw new Error('Vault Files service identity is not configured');
  }
  const router = express.Router();
  router.use((request, response, next) => {
    const serviceId = request.header('x-sulla-service-id');
    const token = request.header('authorization')?.replace(/^Bearer\s+/i, '');
    if (serviceId !== identity.serviceId || !constantEqual(token, identity.token)) {
      response.status(401).json({ error: 'invalid_service_identity', message: 'Files service identity is invalid' });
      return;
    }
    next();
  });
  router.get('/principal', async(_request, response, next) => {
    try {
      response.json(await authority.unlockedPrincipal());
    } catch (error) { next(error) }
  });
  router.post('/custody-recipient', async(request, response, next) => {
    try {
      response.json(await authority.custodyRecipient(context(request.body?.context)));
    } catch (error) { next(error) }
  });
  router.post('/key-bundles', async(request, response, next) => {
    try {
      const input = object(request.body, 'bundle');
      const bundle:RegisteredFilesKeyBundle = {
        context:        context(input.context),
        authorityKeyId: string(input.authorityKeyId, 'authorityKeyId', 1024),
        envelope:       object(input.envelope, 'envelope') as unknown as FilesKeyBundleEnvelope,
      };
      await authority.registerBundle(bundle);
      response.status(204).end();
    } catch (error) { next(error) }
  });
  router.post('/device-recovery', async(request, response, next) => {
    try {
      response.json(await authority.authorizeDeviceRecovery({
        context:         context(request.body?.context),
        devicePublicKey: string(request.body?.devicePublicKey, 'devicePublicKey', 1024),
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
