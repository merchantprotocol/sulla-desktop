// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export type FilesRequest = (endpoint:string, init?:RequestInit) => Promise<Response>;

/** Routes privileged Files-local endpoints through the local-service credential path. */
export class SullaUseCaseFilesRequest {
  constructor(private readonly ordinary:FilesRequest, private readonly local:FilesRequest) {}

  send(endpoint:string, init:RequestInit = {}):Promise<Response> {
    return endpoint.startsWith('/v1/local/') ? this.local(endpoint, init) : this.ordinary(endpoint, init);
  }
}
