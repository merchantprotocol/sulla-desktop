// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FILES_HTTPS_ORIGIN } from './sullaFilesTls';

const SYSTEM_AREA_PATHS = new Set([
  '/v1/local/system-areas',
  '/v1/local/system-areas/ingest',
  '/v1/local/system-areas/move',
  '/v1/local/system-areas/audit',
]);

export type FilesRequest = (endpoint:string, init?:RequestInit) => Promise<Response>;

/** Routes privileged Files-local endpoints through the local-service credential path. */
export class SullaUseCaseFilesRequest {
  constructor(private readonly ordinary:FilesRequest, private readonly local:FilesRequest) {}

  async send(endpoint:string, init:RequestInit = {}):Promise<Response> {
    const url = new URL(endpoint, FILES_HTTPS_ORIGIN);
    if (url.origin !== FILES_HTTPS_ORIGIN) throw new Error('Use-case Files requests must use the local Files service');
    const path = `${ url.pathname }${ url.search }`;
    if (SYSTEM_AREA_PATHS.has(url.pathname)) return this.local(path, init);
    if (/^\/v1\/local(\/|$)/i.test(url.pathname)) throw new Error(`Use-case Files requests cannot call ${ url.pathname }`);
    return this.ordinary(path, init);
  }
}
