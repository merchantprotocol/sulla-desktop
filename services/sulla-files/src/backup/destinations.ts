// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { constants } from 'node:fs';
import { access, copyFile, link, mkdir, open, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

export type BackupDestinationConfig =
  | { kind:'local'; root:string }
  | { kind:'nas'; share:string; protocol:'smb' | 'nfs'; vaultCredentialId?:string }
  | { kind:'s3'; endpoint:string; bucket:string; prefix?:string; region?:string; vaultCredentialId:string };

export interface BackupObjectStore {
  readonly description:string;
  has(key:string):Promise<boolean>;
  putImmutable(key:string, value:Buffer | string):Promise<void>;
  putFileImmutable(key:string, source:string):Promise<void>;
  get(key:string):Promise<Buffer>;
  remove(key:string):Promise<void>;
  close():Promise<void>;
}

export const BACKUP_ROOT = '/var/lib/sulla-files-backups';

export function localBackupRoot(root:unknown):string {
  if (typeof root !== 'string' || !root.startsWith(`${ BACKUP_ROOT }/`) || root.includes('\\') || root.split('/').some(part => part === '.' || part === '..')) throw new Error('Local backups require a subfolder of the VM backup disk');
  const subdir=root.slice(BACKUP_ROOT.length+1);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(subdir) || subdir.startsWith('nas-')) throw new Error('Invalid local backup subfolder');
  return root;
}

export async function checkedBackupDirectory(root:string):Promise<string> {
  await mkdir(root,{recursive:true,mode:0o700});
  if (await realpath(root) !== root) throw new Error('Backup directories cannot contain symbolic links');
  return root;
}

export interface S3BackupClient {
  head(bucket:string,key:string):Promise<boolean>;
  put(bucket:string,key:string,value:Buffer):Promise<void>;
  get(bucket:string,key:string):Promise<Buffer>;
  delete(bucket:string,key:string):Promise<void>;
  putFile(bucket:string,key:string,source:string):Promise<void>;
  close?():void;
}

function safeKey(key:string):string {
  const value = normalize(key).replaceAll('\\', '/');
  if (!value || isAbsolute(value) || value === '..' || value.startsWith('../')) throw new Error('Unsafe backup object key');
  return value;
}

export class LocalBackupObjectStore implements BackupObjectStore {
  readonly description:string;
  constructor(private readonly root:string, private readonly cleanup?:()=>Promise<void>) {
    this.root = resolve(root); this.description = `local:${ this.root }`;
  }
  private path(key:string):string {
    const result = resolve(this.root, safeKey(key));
    if (relative(this.root, result).startsWith('..')) throw new Error('Backup object escaped its destination');
    return result;
  }
  async has(key:string):Promise<boolean> { try { await access(this.path(key), constants.F_OK); return true } catch (error:any) { if (error?.code === 'ENOENT') return false; throw error } }
  async putImmutable(key:string,value:Buffer|string):Promise<void> {
    const destination = this.path(key); await mkdir(dirname(destination), { recursive:true, mode:0o700 });
    const temporary = `${ destination }.tmp-${ process.pid }-${ Date.now() }`;
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(value); await handle.sync() } finally { await handle.close() }
    try { await link(temporary,destination) } catch (error:any) { if (error?.code !== 'EEXIST') throw error } finally { await rm(temporary,{force:true}) }
  }
  async putFileImmutable(key:string,source:string):Promise<void> {
    const destination = this.path(key); if (await this.has(key)) return;
    await mkdir(dirname(destination), { recursive:true, mode:0o700 });
    const temporary = `${ destination }.tmp-${ process.pid }-${ Date.now() }`;
    await copyFile(source,temporary,constants.COPYFILE_EXCL);
    const handle = await open(temporary,'r'); try { await handle.sync() } finally { await handle.close() }
    try { await link(temporary,destination) } catch (error:any) { if (error?.code !== 'EEXIST') throw error } finally { await rm(temporary,{force:true}) }
  }
  get(key:string):Promise<Buffer> { return readFile(this.path(key)) }
  remove(key:string):Promise<void> { return rm(this.path(key), { force:true }) }
  close():Promise<void> { return this.cleanup?.() ?? Promise.resolve() }
}

class S3ObjectStore implements BackupObjectStore {
  readonly description:string;
  constructor(private readonly config:Extract<BackupDestinationConfig,{kind:'s3'}>,private readonly client:S3BackupClient) {
    const endpoint = new URL(config.endpoint); if (endpoint.protocol !== 'https:') throw new Error('S3 backup destinations require HTTPS');
    this.description = `s3:${ endpoint.origin }/${ config.bucket }`;
  }
  private key(key:string):string { return [this.config.prefix?.replace(/^\/+|\/+$/g,''), safeKey(key)].filter(Boolean).join('/') }
  has(key:string):Promise<boolean> { return this.client.head(this.config.bucket,this.key(key)) }
  putImmutable(key:string,value:Buffer|string):Promise<void> { return this.client.put(this.config.bucket,this.key(key),Buffer.isBuffer(value) ? value : Buffer.from(value)) }
  putFileImmutable(key:string,source:string):Promise<void> { return this.client.putFile(this.config.bucket,this.key(key),source) }
  get(key:string):Promise<Buffer> { return this.client.get(this.config.bucket,this.key(key)) }
  remove(key:string):Promise<void> { return this.client.delete(this.config.bucket,this.key(key)) }
  async close():Promise<void> { this.client.close?.() }
}

export async function openBackupDestination(config:Exclude<BackupDestinationConfig,{kind:'nas'}>, dependencies:{ s3?:S3BackupClient } = {}):Promise<BackupObjectStore> {
  if (config.kind === 'local') return new LocalBackupObjectStore(await checkedBackupDirectory(localBackupRoot(config.root)));
  if (!dependencies.s3) throw new Error('S3 backup transport is not configured');
  return new S3ObjectStore(config, dependencies.s3);
}
