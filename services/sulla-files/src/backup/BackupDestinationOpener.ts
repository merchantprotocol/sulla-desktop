// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { open, readFile } from 'node:fs/promises';

import { BACKUP_ROOT, checkedBackupDirectory, localBackupRoot, LocalBackupObjectStore, openBackupDestination, type BackupDestinationConfig, type BackupObjectStore } from './destinations.js';
import type { BackupRuntimeRequests } from './runtime.js';
import { AwsS3BackupClient } from './s3.js';
import type { VaultFilesKeyBundleAuthority } from '../vaultKeyBundleAuthority.js';

/**
 * Opens one personal backup destination for a scheduled or on-demand run: a per-destination
 * folder on the VM backup disk, a Desktop-mounted NAS share (verified hardened mount), or an
 * S3 bucket signed with Vault-held credentials.
 */
export class BackupDestinationOpener {
  constructor(
    private readonly runtime:BackupRuntimeRequests,
    private readonly vault:VaultFilesKeyBundleAuthority | undefined,
  ) {}

  async open(id:string, destination:BackupDestinationConfig):Promise<BackupObjectStore> {
    if(destination.kind==='local') {
      const root=await checkedBackupDirectory(localBackupRoot(destination.root));
      return new LocalBackupObjectStore(await checkedBackupDirectory(`${ root }/destinations/${ id }`));
    }
    if(destination.kind==='nas') return this.openNas(id);
    if(!this.vault) throw new Error('Vault backup credential authority is unavailable');
    const client=new AwsS3BackupClient(destination.endpoint,await this.vault.backupCredentials(destination.vaultCredentialId,destination.endpoint),destination.region);
    try { return await openBackupDestination({...destination,prefix:[destination.prefix,`destinations/${ id }`].filter(Boolean).join('/')},{s3:client}) } catch(error) {client.close();throw error}
  }

  /** Desktop mounts the share; Files only uses it once the mount is visible here as nosuid,nodev,noexec cifs/nfs. */
  private async openNas(id:string):Promise<BackupObjectStore> {
    await this.runtime.prepare(id);
    const point=`${ BACKUP_ROOT }/nas-${ id }`;
    const mounts=(await readFile('/proc/self/mountinfo','utf8')).split('\n');
    if(!mounts.some(line=>{const parts=line.split(' ');const separator=parts.indexOf('-');return parts[4]===point && ['cifs','nfs','nfs4'].includes(parts[separator+1]) && ['nosuid','nodev','noexec'].every(flag=>parts[5].split(',').includes(flag))})) throw new Error('NAS mount did not propagate into Files');
    const handle=await open(point,'r');
    try { return new LocalBackupObjectStore(await checkedBackupDirectory(`${ point }/sulla-files-backups/${ id }`),()=>handle.close()) } catch(error) {await handle.close();throw error}
  }
}
