// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { DatabaseFolderState } from './DatabaseBatchTypes.js';
import type { DatabaseOperationContext } from './DatabaseOperationContext.js';
import type { DatabaseOperationAccess } from './DatabaseOperationTypes.js';

/** One locked folder subtree with the signature the caller must have seen. */
export interface FolderTree {
  destinationFiles:any[]; destinationFolders:any[]; destinationNativeFolders:string[];
  folderShares:any[]; publicLinks:any[]; fileIds:string[];
  fileSharesSignature:string; fileLinksSignature:string; nativeSignature:string; subtreeSignature:string;
  root:any; snapshot?:DatabaseFolderState;
}

/** Snapshots folder subtrees and computes their stable subtree signatures. */
export class FolderSubtreeInspector {
  constructor(private readonly context:DatabaseOperationContext) {}

  static state(folder:any):DatabaseFolderState {
    return { collectionId:folder.collection_id,folderId:folder.id,path:folder.path,revision:String(folder.operation_revision) };
  }

  static canonical(value:any):string {
    return JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
  }

  static sha256(value:any):string { return createHash('sha256').update(FolderSubtreeInspector.canonical(value)).digest('hex') }

  /** Children run with metadata-only custody: the folder's one native journal publishes the whole subtree. */
  static metadataAccess(access:DatabaseOperationAccess):DatabaseOperationAccess {
    return { ...access, ...(access.custody?{ custody:{ ...access.custody,publish:async()=>undefined } }:{}) };
  }

  /** The live folder state a caller displays before a folder operation (no locks). */
  async displayState(collectionId:string, path:string, access:DatabaseOperationAccess):Promise<{
    collectionId:string;path:string;folderId?:string;revision?:string;subtreeSignature:string;
  }> {
    const { subtree, grants } = this.context;
    await access.prepare?.(collectionId);
    return this.context.transaction.run(async client=>{
      await access.path(client,collectionId,path);
      const files = await subtree.liveFiles(client, collectionId, path);
      const folders = await subtree.liveFolders(client, collectionId, path);
      const native = access.custody?await access.custody.folderSnapshot(collectionId,path,files.map(file=>file.path)):
        {directories:[],nativeSignature:FolderSubtreeInspector.sha256({files:[],directories:[]})};
      if (!files.length && !folders.length && !native.directories.length) throw Object.assign(new Error('Folder not found'),{status:404});
      for (const file of files) await access.file(client,file.id);
      for (const folder of folders) await access.path(client,collectionId,folder.path);
      const folderShares = await grants.shares(client, collectionId, path);
      const publicLinks = await grants.links(client, collectionId, path);
      const fileIds = files.map(file=>file.id);
      const fileSharesSignature = await grants.fileSharesSignature(client, fileIds);
      const fileLinksSignature = await grants.fileLinksSignature(client, fileIds);
      const subtreeSignature = FolderSubtreeInspector.sha256({files:files.map(file=>({id:file.id,path:file.path,versionId:file.current_version_id,revision:String(file.operation_revision),deleted:false})),
        folders:folders.map(FolderSubtreeInspector.state),folderShares,publicLinks,fileSharesSignature,fileLinksSignature,nativeSignature:native.nativeSignature});
      const root = folders.find(folder=>folder.path===path);
      return {collectionId,path,...(root?{folderId:root.id,revision:String(root.operation_revision)}:{}),subtreeSignature};
    });
  }

  /** Locks the subtree (or reuses rows already locked by the caller) and signs it. */
  async tree(client:pg.PoolClient, access:DatabaseOperationAccess, collectionId:string, path:string, treeFiles?:any[], treeFolders?:any[]):Promise<FolderTree> {
    const { subtree, grants } = this.context;
    const destinationFiles = treeFiles??await subtree.lockFilesByPath(client, collectionId, path);
    const destinationFolders = treeFolders??await subtree.lockFoldersByDepth(client, collectionId, path);
    const native = access.custody
      ? await access.custody.folderSnapshot(collectionId,path,destinationFiles.map(file=>file.path))
      : {directories:[],nativeSignature:FolderSubtreeInspector.sha256({files:[],directories:[]})};
    const folderShares = await grants.shares(client, collectionId, path, true);
    const publicLinks = await grants.links(client, collectionId, path, true);
    const fileIds = destinationFiles.map(file=>file.id);
    const fileSharesSignature = await grants.fileSharesSignature(client, fileIds);
    const fileLinksSignature = await grants.fileLinksSignature(client, fileIds);
    const root = destinationFolders.find(folder=>folder.path===path);
    const subtreeSignature = FolderSubtreeInspector.sha256({files:destinationFiles.map(file=>({id:file.id,path:file.path,versionId:file.current_version_id,revision:String(file.operation_revision),deleted:Boolean(file.deleted_at)})),
      folders:destinationFolders.map(FolderSubtreeInspector.state),folderShares,publicLinks,fileSharesSignature,fileLinksSignature,nativeSignature:native.nativeSignature});
    return {destinationFiles,destinationFolders,destinationNativeFolders:native.directories,folderShares,publicLinks,fileIds,fileSharesSignature,fileLinksSignature,nativeSignature:native.nativeSignature,subtreeSignature,root,
      snapshot:root?{...FolderSubtreeInspector.state(root),subtreeSignature}:undefined};
  }

  /**
   * Every directory a subtree plan must carry, implicit ancestors included, so native and stored
   * empty directories get one stable shallow-first order rather than fake placeholder file identities.
   */
  static orderedPaths(root:string, folders:any[], nativeFolders:string[], files:any[]):string[] {
    const paths = new Set<string>([root,...folders.map(f=>f.path),...nativeFolders]);
    for (const file of files) {
      let path = file.path.slice(0,file.path.lastIndexOf('/'));
      while (path===root || path.startsWith(root+'/')) { paths.add(path); path=path.slice(0,path.lastIndexOf('/')); if (!path.includes('/') && path!==root) break }
    }
    return [...paths].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b));
  }
}
