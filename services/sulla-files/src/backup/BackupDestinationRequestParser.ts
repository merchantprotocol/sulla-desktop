// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { localBackupRoot, type BackupDestinationConfig } from './destinations.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';

export interface BackupDestinationRequest { kind:BackupDestinationConfig['kind']; label:string; destination:BackupDestinationConfig }

/** Validates a "create backup destination" body: no credentials in URLs, Vault item ids for secrets, HTTPS-only S3. */
export class BackupDestinationRequestParser {
  parse(body:any):BackupDestinationRequest {
    const kind=body?.kind; const label=String(body?.label??'').trim(); const fields=body?.config;
    if (!['local','nas','s3'].includes(kind) || fields?.kind!==kind || !label || label.length>200) throw new HttpError(400,'Invalid backup destination');
    if(fields.vaultCredentialId && (typeof fields.vaultCredentialId!=='string' || !FilesRequestInput.UUID.test(fields.vaultCredentialId))) throw new HttpError(400,'Enter a valid Vault item UUID');
    let destination:BackupDestinationConfig;
    if (kind==='local') {
      try { destination={kind,root:localBackupRoot(fields.root)} } catch { throw new HttpError(400,'Local backups require a valid subfolder on the Sulla VM backup disk') }
    } else if(kind==='nas') {
      let share:URL;
      try {share=new URL(fields.share)} catch {throw new HttpError(400,'Enter a valid NAS share URL')}
      if(!['smb','nfs'].includes(fields.protocol) || share.protocol!==`${ fields.protocol }:` || !share.hostname || share.pathname==='/' || share.username || share.password || share.search || share.hash || share.port) throw new HttpError(400,'Enter an smb://server/share or nfs://server/export URL without credentials');
      if(fields.protocol==='smb' && !fields.vaultCredentialId) throw new HttpError(400,'SMB backups require Vault credentials');
      destination={kind,share:fields.share,protocol:fields.protocol,...(fields.vaultCredentialId?{vaultCredentialId:String(fields.vaultCredentialId)}:{})};
    } else {
      let endpoint:URL;
      try {endpoint=new URL(fields.endpoint)} catch {throw new HttpError(400,'Enter a valid HTTPS S3 endpoint')}
      if(endpoint.protocol!=='https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !fields.bucket || !fields.vaultCredentialId) throw new HttpError(400,'S3 backups require HTTPS, a bucket, and Vault credentials');
      if(fields.region && (typeof fields.region!=='string' || !/^[A-Za-z0-9-]{1,64}$/.test(fields.region))) throw new HttpError(400,'Invalid S3 signing region');
      destination={kind:'s3',endpoint:fields.endpoint,bucket:String(fields.bucket),vaultCredentialId:String(fields.vaultCredentialId),...(fields.region?{region:fields.region}:{}),...(fields.prefix?{prefix:String(fields.prefix)}:{})};
    }
    return { kind, label, destination };
  }
}
