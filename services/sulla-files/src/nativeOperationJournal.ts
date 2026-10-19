import { createHash,randomUUID } from 'node:crypto';
import type pg from 'pg';
import { FilesMutationCoordinator } from './safeFilesystem.js';
import type { FileFingerprint, DirectoryReceipt, PinnedRegularFile } from './safeFilesystem.js';
import { isProtectedPath,protectedPathError } from './protectedFiles.js';
import { assertOperationNotCancelled } from './operationCancellation.js';

type Fingerprint = { dev:string; ino:string; size:number; mtimeMs:number };
interface Leaf {
  kind:'move'|'copy'|'trash'|'restore'|'mkdir'|'rmdir'|'restore-dir';
  source?:string; target?:string; stage:string; hash?:string;
  before?:Fingerprint; published?:Fingerprint; directory?:DirectoryReceipt;
  retainedDirectory?:DirectoryReceipt;
}
interface Plan {
  version:2; rootId:string; collectionId:string; operationId:string; itemId:string;
  leaves:Leaf[]; inverse?:Leaf[]; watched:any[];
  committed?:Committed; inverseCommitted?:Committed;
  treeBefore?:string; treeAfter?:string;
  treesAfter?:string[]; absentAfter?:string[]; treesUndo?:string[]; absentUndo?:string[];
  grants?:any;
  disposal?:{undoInvalidatedAt:string;invalidatedBy:string;reason:string;disposedPaths?:string[];artifactsDisposedAt?:string;lastError?:string};
}
interface Committed { fileIds:string[]; folderIds:string[]; files:any[]; folders:any[]; watched:any[]; grants?:any }
export interface NativeJournalRoot { id:string; collectionId:string; mutations:FilesMutationCoordinator }
const packed = (value:FileFingerprint):Fingerprint => ({ ...value,dev:String(value.dev),ino:String(value.ino) });
const same = (a:Fingerprint,b:Fingerprint) => a.dev===b.dev && a.ino===b.ino && a.size===b.size && a.mtimeMs===b.mtimeMs;
const failure = () => Object.assign(new Error('Native operation requires preserved-artifact reconciliation'),{ status:409,code:'recovery-required' });
const canonical=(value:any):string=>JSON.stringify(value,(_key,item)=>item && typeof item==='object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key=>[key,item[key]])):item);
async function verify(pinned:PinnedRegularFile,hash:string,expected?:Fingerprint):Promise<void> {
  if (expected && !same(packed(pinned.fingerprint),expected)) throw failure();
  const digest=createHash('sha256');
  for await (const chunk of pinned.createReadStream()) digest.update(chunk);
  if (digest.digest('hex')!==hash) throw failure();
  await pinned.assertUnchanged();
}

/** Uses only files_path_operations; LocalFilesManager owns scheduling/recovery. */
export class NativeOperationJournal {
  constructor(private readonly db:pg.Pool,private readonly resolve:(collectionId:string)=>Promise<NativeJournalRoot|null>,
    private readonly verifyVersion:(fileId:string,versionId:string,hash:string)=>Promise<void>) {}

  async occupied(collectionId:string,path:string):Promise<boolean> {
    const root=await this.resolve(collectionId);
    return root?root.mutations.exists(path):false;
  }

  async folders(collectionId:string,path:string,files:string[]):Promise<string[]> {
    return (await this.folderSnapshot(collectionId,path,files)).directories;
  }

  async folderSnapshot(collectionId:string,path:string,files:string[]):Promise<{directories:string[];nativeSignature:string}> {
    const root=await this.resolve(collectionId);
    if (!root) return {directories:[],nativeSignature:createHash('sha256').update(canonical({files:[],directories:[]})).digest('hex')};
    const tree=await root.mutations.inspectTree(path,path=>!isProtectedPath(path) && !path.split('/').includes('.sulla-trash'));
    if ([...tree.directories,...tree.files].some(isProtectedPath)) throw protectedPathError();
    if (tree.files.length!==files.length || tree.files.some(path=>!files.includes(path))) throw failure();
    const directories:DirectoryReceipt[]=[];
    for (const directoryPath of [...tree.directories].sort()) directories.push(await root.mutations.directory(directoryPath));
    const nativeFiles:{path:string;fingerprint:Fingerprint;hash:string}[]=[];
    for (const filePath of [...tree.files].sort()) {
      const pin=await root.mutations.pinVerified(filePath,async()=>undefined);
      try {
        const digest=createHash('sha256');
        for await (const chunk of pin.createReadStream()) digest.update(chunk);
        await pin.assertUnchanged();
        nativeFiles.push({path:filePath,fingerprint:packed(pin.fingerprint),hash:digest.digest('hex')});
      } finally { await pin.close() }
    }
    return {directories:tree.directories,nativeSignature:createHash('sha256').update(canonical({files:nativeFiles,directories})).digest('hex')};
  }

  async publish(client:pg.PoolClient,receipt:any,undo:boolean):Promise<void> {
    const root=await this.resolve(receipt.collection_id);
    if (!root) return;
    const m=root.mutations;
    await m.runExclusive([],async() => {
      await FilesMutationCoordinator.requireAtomicRename();
      if (undo) return this.inverse(client,receipt,root);
      const itemId=receipt.request.itemId ?? receipt.id;
      const operationId=receipt.request.batchOperationId ?? receipt.id;
      const prefix=`.sulla-trash/.operations/${operationId}/${itemId}/${receipt.id}`;
      const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
      const incomingRecords=folderPlan?.children?.map((c:any)=>({ before_state:c.before,after_state:c.after,action:c.action })) ?? [receipt];
      const displacedRecords=folderPlan?.displaced?.children?.map((c:any)=>({ before_state:c.before,after_state:c.after,action:c.action })) ?? [];
      const records=[...displacedRecords,...incomingRecords];
      const watched=(await client.query('SELECT * FROM watched_folder_state WHERE file_id=ANY($1::uuid[]) FOR UPDATE',
        [[...records.map((r:any)=>r.before_state?.fileId),receipt.displaced_before?.fileId].filter(Boolean)])).rows;
      const plan:Plan={ version:2,rootId:root.id,collectionId:receipt.collection_id,operationId,itemId,leaves:[],watched };
      if (folderPlan) {
        if (receipt.action!=='copy') plan.treeBefore=folderPlan.source;
        if (receipt.action!=='trash') plan.treeAfter=folderPlan.target;
        if (folderPlan.displaced) {
          plan.treesAfter=[folderPlan.target,folderPlan.displaced.target];
          plan.absentAfter=receipt.action==='copy'?[]:[folderPlan.source];
          plan.treesUndo=[folderPlan.source,folderPlan.displaced.source];
          plan.absentUndo=[folderPlan.displaced.target];
          plan.grants=folderPlan.displaced.grants;
        }
      } else if (receipt.action==='create-folder') plan.treeAfter=receipt.after_state.path;
      const fileLeaf=async(before:any,after:any,kind:Leaf['kind'],stage:string,leaves=plan.leaves) => {
        const w=watched.find(w=>w.file_id===before.fileId);
        if (!w || w.root_id!==root.id || w.path!==before.path) throw failure();
        await this.verifyVersion(before.fileId,before.versionId,w.content_hash);
        const pin=await m.pinVerified(before.path,p=>verify(p,w.content_hash));
        try {
          if (pin.fingerprint.size!==Number(w.size) || pin.fingerprint.mtimeMs!==Number(w.mtime_ms)) throw failure();
          leaves.push({ kind,source:before.path,target:after?.path,stage,hash:w.content_hash,before:packed(pin.fingerprint) });
        } finally { await pin.close() }
      };
      if (receipt.displaced_before) await fileLeaf(receipt.displaced_before,receipt.displaced_after,'move',`${prefix}/displaced`);
      const incomingDirectories:any[]=folderPlan?.folders??[];
      const displacedDirectories:any[]=folderPlan?.displaced?.folders??[];
      const includeParents=(path:string,includeSelf=false)=>{
        const parts=path.split('/'); if (!includeSelf) parts.pop();
        for (let n=1;n<=parts.length;n++) desired.add(parts.slice(0,n).join('/'));
      };
      const desired=new Set<string>();
      const mkdirs=async(paths:Set<string>,label:string,forceWithin?:string):Promise<Leaf[]> => {
        const leaves:Leaf[]=[];
        for (const path of [...paths].sort((a,b)=>a.split('/').length-b.split('/').length || a.localeCompare(b))) {
          const forced=Boolean(forceWithin && (path===forceWithin || path.startsWith(forceWithin+'/')));
          if (!forced && await m.exists(path)) { await m.directory(path); continue }
          leaves.push({kind:'mkdir',target:path,stage:`${prefix}/${label}-${leaves.length}`});
        }
        return leaves;
      };
      if (folderPlan?.displaced) {
        for (const directory of displacedDirectories) includeParents(directory.after.path,true);
        for (const record of displacedRecords) if (record.after_state?.fileId && !record.after_state.deleted) includeParents(record.after_state.path);
        plan.leaves.push(...await mkdirs(desired,'displaced-dir'));
        for (const [index,record] of displacedRecords.entries()) await fileLeaf(record.before_state,record.after_state,'move',`${prefix}/displaced-source-${index}`);
        for (const [index,directory] of [...displacedDirectories].reverse().entries()) plan.leaves.push({kind:'rmdir',source:directory.before.path,
          directory:await m.directory(directory.before.path),stage:`${prefix}/displaced-removed-dir-${index}`});
        desired.clear();
      }
      if (receipt.action==='create-folder') includeParents(receipt.after_state.path,true);
      for (const directory of incomingDirectories) if (!directory.deleted) includeParents(directory.after.path,true);
      for (const record of incomingRecords) if (record.after_state?.fileId && !record.after_state.deleted) includeParents(record.after_state.path);
      if (receipt.displaced_after) includeParents(receipt.displaced_after.path);
      plan.leaves.push(...await mkdirs(desired,'dir',folderPlan?.displaced?.source));
      if (receipt.action!=='create-folder') for (const [index,record] of incomingRecords.entries()) await fileLeaf(record.before_state,record.after_state,record.action==='rename'?'move':record.action,`${prefix}/source-${index}`);
      if (incomingDirectories.length && receipt.action!=='copy') {
        for (const [index,directory] of [...incomingDirectories].reverse().entries()) plan.leaves.push({kind:'rmdir',source:directory.before.path,
          directory:await m.directory(directory.before.path),stage:`${prefix}/removed-dir-${index}`});
      }
      await this.db.query(`INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,$2,'planned',$3)`,[receipt.id,receipt.action,plan]);
      await this.db.query("UPDATE files_path_operations SET state='publishing' WHERE operation_id=$1",[receipt.id]);
      for (const leaf of plan.leaves) {
        assertOperationNotCancelled(operationId);
        if (leaf.kind==='mkdir') {
          const staged=await m.stageDirectory(leaf.stage);
          leaf.directory={...staged,path:leaf.target!};
          // Persist inode ownership BEFORE the directory becomes public.
          await this.save(receipt.id,plan);
        }
        await this.forward(m,leaf);
        await this.save(receipt.id,plan);
      }
      assertOperationNotCancelled(operationId);
      const displacedFileIds=new Set(displacedRecords.map((record:any)=>record.before_state?.fileId).filter(Boolean));
      for (const w of watched) if (receipt.action!=='copy' || displacedFileIds.has(w.file_id) || w.file_id===receipt.displaced_before?.fileId) await client.query('DELETE FROM watched_folder_state WHERE file_id=$1',[w.file_id]);
      for (const state of [...records.map((r:any)=>r.after_state),receipt.displaced_after]) {
        if (!state?.fileId || state.deleted) continue;
        const leaf=plan.leaves.find(l=>l.target===state.path);
        if (!leaf?.published) throw failure();
        await this.watch(client,root,state.fileId,state.path,leaf.hash!,leaf.published);
      }
      plan.committed=await this.capture(client,receipt);
      await client.query("UPDATE files_path_operations SET state='db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
    });
  }

  private async watch(client:pg.PoolClient,root:NativeJournalRoot,fileId:string,path:string,hash:string,fp:Fingerprint):Promise<void> {
    await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`,
    [root.collectionId,path,fileId,hash,fp.size,fp.mtimeMs,root.id]);
  }

  private async save(id:string,plan:Plan):Promise<void> {
    await this.db.query('UPDATE files_path_operations SET plan=$2,updated_at=NOW() WHERE operation_id=$1',[id,plan]);
  }

  private async forward(m:FilesMutationCoordinator,leaf:Leaf):Promise<void> {
    if (leaf.kind==='mkdir') { leaf.directory=await m.restoreEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='rmdir') { await m.evictEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='restore-dir') { leaf.directory=await m.restoreEmptyDirectory(leaf.retainedDirectory!,leaf.stage); return }
    const check=(p:PinnedRegularFile)=>verify(p,leaf.hash!,leaf.before);
    if (leaf.kind==='copy') {
      const pin=await m.pinVerified(leaf.source!,check); await pin.close();
      const result=await m.copyVerified({ source:leaf.source!,target:leaf.target!,staged:leaf.stage,verify:p=>verify(p,leaf.hash!) });
      leaf.published=packed(result.fingerprint); return;
    }
    if (leaf.kind==='restore') {
      const result=await m.publishVerified({ staged:leaf.stage,target:leaf.target!,verify:check });
      leaf.published=packed(result.fingerprint); return;
    }
    await m.evictVerified({ source:leaf.source!,quarantine:leaf.stage,verify:check });
    if (leaf.kind==='move') {
      const result=await m.publishVerified({ staged:leaf.stage,target:leaf.target!,verify:check });
      leaf.published=packed(result.fingerprint);
    }
  }

  private async inverse(client:pg.PoolClient,receipt:any,root:NativeJournalRoot):Promise<void> {
    const row=(await this.db.query('SELECT * FROM files_path_operations WHERE operation_id=$1',[receipt.id])).rows[0];
    if (!row || row.plan.version!==2 || !['completed','db-committed'].includes(row.state)) throw failure();
    const plan:Plan=row.plan;
    // Validate ALL targets before moving the first byte.
    for (const leaf of plan.leaves) {
      if (leaf.kind==='mkdir') {
        const actual=await root.mutations.directory(leaf.target!);
        if (actual.dev!==leaf.directory?.dev || actual.ino!==leaf.directory?.ino) throw failure();
      } else if (leaf.kind==='rmdir') {
        const retained=await root.mutations.directory(leaf.stage);
        if (retained.dev!==leaf.directory?.dev || retained.ino!==leaf.directory?.ino) throw failure();
      } else {
        const pin=await root.mutations.pinVerified(leaf.kind==='trash'?leaf.stage:leaf.target!,p=>verify(p,leaf.hash!,leaf.published??leaf.before));
        await pin.close();
      }
    }
    const attempt=randomUUID();
    plan.inverse=[...plan.leaves].reverse().map((leaf,index):Leaf => {
      const stage=`.sulla-trash/.operations/${plan.operationId}/${plan.itemId}/${receipt.id}/undo-${attempt}-${index}`;
      if (leaf.kind==='mkdir') return { kind:'rmdir',stage,directory:leaf.directory };
      if (leaf.kind==='rmdir') return { kind:'restore-dir',stage:leaf.stage,directory:leaf.directory,retainedDirectory:leaf.directory };
      if (leaf.kind==='trash') return { kind:'restore',target:leaf.source,stage:leaf.stage,hash:leaf.hash,before:leaf.before };
      return { kind:leaf.kind==='copy'?'trash':'move',source:leaf.target,target:leaf.source,stage,hash:leaf.hash,before:leaf.published };
    });
    await this.db.query("UPDATE files_path_operations SET state='undo-planned',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
    await this.db.query("UPDATE files_path_operations SET state='undo-publishing' WHERE operation_id=$1",[receipt.id]);
    for (const leaf of plan.inverse) { await this.forward(root.mutations,leaf); await this.save(receipt.id,plan) }
    const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
    const states=folderPlan?[...folderPlan.children,...(folderPlan.displaced?.children??[])].map((c:any)=>c.after):[receipt.after_state,receipt.displaced_after];
    for (const state of states) if (state?.fileId) await client.query('DELETE FROM watched_folder_state WHERE file_id=$1',[state.fileId]);
    const displacedFileIds=new Set((folderPlan?.displaced?.children??[]).map((child:any)=>child.before?.fileId).filter(Boolean));
    for (const w of plan.watched) {
      if (receipt.action==='copy' && !displacedFileIds.has(w.file_id) && w.file_id!==receipt.displaced_before?.fileId) continue;
      const pin=await root.mutations.pinVerified(w.path,p=>verify(p,w.content_hash));
      try { await this.watch(client,root,w.file_id,w.path,w.content_hash,packed(pin.fingerprint)) } finally { await pin.close() }
    }
    plan.inverseCommitted=await this.capture(client,receipt);
    await client.query("UPDATE files_path_operations SET state='undo-db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
  }

  private async capture(client:Pick<pg.PoolClient,'query'>,receipt:any):Promise<Committed> {
    const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
    const records=folderPlan?[...folderPlan.children,...(folderPlan.displaced?.children??[])]:[{before:receipt.before_state,after:receipt.after_state},
      {before:receipt.displaced_before,after:receipt.displaced_after}];
    const fileIds=[...new Set<string>(records.flatMap((r:any)=>[r.before?.fileId,r.after?.fileId]).filter(Boolean))].sort();
    const folderIds=[...new Set<string>((folderPlan?[...folderPlan.folders,...(folderPlan.displaced?.folders??[])]:[{after:receipt.after_state}]).flatMap((r:any)=>[r.before?.folderId,r.after?.folderId]).filter(Boolean))].sort();
    const committed=await this.captureIds(client,fileIds,folderIds);
    if (folderPlan?.displaced?.grants) committed.grants=await this.captureGrants(client,folderPlan.displaced.grants);
    return committed;
  }

  private async captureGrants(client:Pick<pg.PoolClient,'query'>,grants:any):Promise<any> {
    const folderShareIds=(grants.folderShares??[]).map((item:any)=>item.id);
    const publicLinkIds=(grants.publicLinks??[]).map((item:any)=>item.id);
    const fileIds=grants.fileIds??[];
    const signature=async(table:string,column:string,order:string,ids:string[],cast:string) => (await client.query(
      `SELECT md5(COALESCE(jsonb_agg(to_jsonb(item) ORDER BY item.${order}),'[]'::jsonb)::text) signature FROM ${table} item WHERE item.${column}=ANY($1::${cast}[])`,[ids])).rows[0].signature;
    return {folderShareIds,publicLinkIds,fileIds,
      folderSharesSignature:await signature('folder_shares','id','id',folderShareIds,'uuid'),
      publicLinksSignature:await signature('file_share_links','id','id',publicLinkIds,'text'),
      fileSharesSignature:await signature('file_shares','file_id','id',fileIds,'uuid'),
      fileLinksSignature:await signature('file_share_links','file_id','id',fileIds,'uuid')};
  }

  private async captureIds(client:Pick<pg.PoolClient,'query'>,fileIds:string[],folderIds:string[]):Promise<Committed> {
    const files=(await client.query(`SELECT id::text,collection_id::text,path,current_version_id::text,operation_revision::text,deleted_at IS NOT NULL AS deleted
      FROM files WHERE id=ANY($1::uuid[]) ORDER BY id`,[fileIds])).rows;
    const folders=(await client.query(`SELECT id::text,collection_id::text,path,operation_revision::text,deleted_at IS NOT NULL AS deleted
      FROM file_folders WHERE id=ANY($1::uuid[]) ORDER BY id`,[folderIds])).rows;
    const watched=(await client.query(`SELECT file_id::text,collection_id::text,root_id,path,content_hash,size::text,mtime_ms::text
      FROM watched_folder_state WHERE file_id=ANY($1::uuid[]) ORDER BY file_id`,[fileIds])).rows;
    return {fileIds,folderIds,files,folders,watched};
  }

  private async verifyCommitted(root:NativeJournalRoot,plan:Plan,undo:boolean):Promise<void> {
    const expected=undo?plan.inverseCommitted:plan.committed;
    if (!expected) throw failure();
    const actual=await this.captureIds(this.db,expected.fileIds,expected.folderIds);
    if (expected.grants) actual.grants=await this.captureGrants(this.db,plan.grants);
    if (canonical(expected)!==canonical(actual)) throw failure();
    const leaves=undo?plan.inverse!:plan.leaves;
    const finalTargets=new Set(leaves.filter(l=>['move','copy','restore','mkdir'].includes(l.kind)).map(l=>l.target));
    for (const leaf of leaves) {
      if (leaf.kind==='mkdir' || leaf.kind==='restore-dir') {
        const actual=await root.mutations.directory(leaf.directory!.path);
        if (actual.dev!==leaf.directory!.dev || actual.ino!==leaf.directory!.ino) throw failure();
      } else if (leaf.kind==='rmdir') {
        const retained=await root.mutations.directory(leaf.stage);
        if (retained.dev!==leaf.directory!.dev || retained.ino!==leaf.directory!.ino || await root.mutations.exists(leaf.directory!.path)) throw failure();
        const tree=await root.mutations.inspectTree(leaf.stage);
        if (tree.files.length || tree.directories.length!==1) throw failure();
      } else {
        const pin=await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.kind==='copy'?leaf.published:leaf.before)); await pin.close();
        if (leaf.kind!=='trash') {
          const target=await root.mutations.pinVerified(leaf.target!,p=>verify(p,leaf.hash!,leaf.published)); await target.close();
        }
        if ((leaf.kind==='move' || leaf.kind==='trash') && !finalTargets.has(leaf.source) && await root.mutations.exists(leaf.source!)) throw failure();
      }
    }
    const treePaths=undo?(plan.treesUndo??(plan.treeBefore?[plan.treeBefore]:[])):(plan.treesAfter??(plan.treeAfter?[plan.treeAfter]:[]));
    const absentPaths=undo?(plan.absentUndo??(plan.treeAfter?[plan.treeAfter]:[])):(plan.absentAfter??(plan.treeBefore?[plan.treeBefore]:[]));
    for (const absentPath of absentPaths) if (!treePaths.includes(absentPath) && await root.mutations.exists(absentPath)) throw failure();
    for (const treePath of treePaths) {
      const tree=await root.mutations.inspectTree(treePath,path=>!isProtectedPath(path));
      const inTree=(entry:any)=>!entry.deleted && (entry.path===treePath || entry.path.startsWith(treePath+'/'));
      const files=expected.files.filter(inTree).map(f=>f.path).sort();
      const dirs=expected.folders.filter(inTree).map(f=>f.path).sort();
      if (canonical(tree.files.sort())!==canonical(files) || canonical(tree.directories.sort())!==canonical(dirs)) throw failure();
    }
    // Old inverse artifacts stay part of the custody proof after undo too.
    if (undo) for (const leaf of plan.leaves) {
      if (leaf.hash) { const pin=await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.published??leaf.before)); await pin.close() }
      if (leaf.kind==='rmdir') {
        const kept=await root.mutations.directory(leaf.directory!.path);
        if (kept.dev!==leaf.directory!.dev || kept.ino!==leaf.directory!.ino) throw failure();
      }
    }
  }

  async recover(row:any):Promise<void> {
    const plan:Plan=row.plan;
    const root=await this.resolve(plan.collectionId);
    if (!root || root.id!==plan.rootId) throw failure();
    await root.mutations.runExclusive([],async() => {
      const undo=row.state.startsWith('undo-');
      if (['db-committed','undo-db-committed'].includes(row.state)) await this.verifyCommitted(root,plan,undo);
      if (!['db-committed','undo-db-committed'].includes(row.state)) {
        for (const leaf of [...(undo?plan.inverse!:plan.leaves)].reverse()) await this.rollback(root.mutations,leaf);
        if (undo) {
          for (const leaf of plan.leaves) if (leaf.kind==='mkdir') leaf.directory=await root.mutations.directory(leaf.target!);
          await this.save(row.operation_id,plan);
        }
      }
      // Retain stages for undo; never finalize/delete recovery artifacts here.
      await this.db.query('UPDATE files_path_operations SET state=$2,last_error=NULL,updated_at=NOW() WHERE operation_id=$1',
        [row.operation_id,row.state==='undo-db-committed'?'undone':undo?'completed':row.state==='db-committed'?'completed':'rolled-back']);
    });
  }

  /** GC only the exact retained identities recorded by one invalidated receipt. */
  async dispose(receiptId:string):Promise<{state:'none'|'complete'|'recovery-required';error?:string}> {
    const row=(await this.db.query('SELECT * FROM files_path_operations WHERE operation_id=$1',[receiptId])).rows[0];
    if (!row) return {state:'none'};
    const plan:Plan=row.plan;
    if (row.action!=='trash' || !plan?.disposal?.undoInvalidatedAt) throw failure();
    if (!['completed','undone','rolled-back'].includes(row.state)) throw failure();
    if (plan.disposal.artifactsDisposedAt) return {state:'complete'};
    const root=await this.resolve(plan.collectionId);
    if (!root || root.id!==plan.rootId) return {state:'recovery-required',error:'Native root is unavailable; retained artifacts were preserved'};
    try {
      await root.mutations.runExclusive([],async()=>{
        const disposed=new Set(plan.disposal!.disposedPaths??[]);
        for (const leaf of plan.leaves) {
          if (disposed.has(leaf.stage)) continue;
          if (leaf.kind==='rmdir') {
            if (!leaf.directory) throw failure();
            if (await root.mutations.exists(leaf.stage)) await root.mutations.disposeRetainedDirectory({...leaf.directory,path:leaf.stage});
            else if (row.state==='undone') {
              const restored=await root.mutations.directory(leaf.directory.path);
              if (restored.dev!==leaf.directory.dev || restored.ino!==leaf.directory.ino) throw failure();
            } else if (row.state!=='completed') throw failure();
          } else if (leaf.hash && leaf.before) {
            if (await root.mutations.exists(leaf.stage)) await root.mutations.disposeRetainedFile(leaf.stage,{dev:BigInt(leaf.before.dev),ino:BigInt(leaf.before.ino),size:leaf.before.size,mtimeMs:leaf.before.mtimeMs},p=>verify(p,leaf.hash!,leaf.before));
          } else continue;
          disposed.add(leaf.stage); plan.disposal!.disposedPaths=[...disposed]; plan.disposal!.lastError=undefined; await this.save(receiptId,plan);
        }
        plan.disposal!.artifactsDisposedAt=new Date().toISOString(); plan.disposal!.lastError=undefined; await this.save(receiptId,plan);
      });
      return {state:'complete'};
    } catch(error:any) {
      plan.disposal.lastError=String(error?.message??error).slice(0,1000); await this.save(receiptId,plan).catch(()=>undefined);
      return {state:'recovery-required',error:'Retained artifacts were preserved because ownership verification or cleanup did not complete'};
    }
  }

  private async rollback(m:FilesMutationCoordinator,leaf:Leaf):Promise<void> {
    if (leaf.kind==='mkdir') {
      if (!await m.exists(leaf.target!)) return;
      if (!leaf.directory) throw failure();
      const retained=leaf.stage;
      if (await m.exists(retained)) throw failure();
      await m.evictEmptyDirectory(leaf.directory,retained); return;
    }
    if (leaf.kind==='rmdir') {
      if (!await m.exists(leaf.directory!.path)) {
        await m.restoreEmptyDirectory(leaf.directory!,leaf.stage); return;
      }
      const current=await m.directory(leaf.directory!.path);
      if (current.dev!==leaf.directory!.dev || current.ino!==leaf.directory!.ino) throw failure();
      return;
    }
    if (leaf.kind==='restore-dir') {
      if (await m.exists(leaf.directory!.path)) await m.evictEmptyDirectory(leaf.directory!,leaf.stage);
      return;
    }
    const staged=await m.exists(leaf.stage);
    if (!staged) {
      if (leaf.kind==='copy') { if (await m.exists(leaf.target!)) throw failure(); return }
      if (!leaf.source) throw failure();
      const pin=await m.pinVerified(leaf.source,p=>verify(p,leaf.hash!,leaf.before)); await pin.close(); return;
    }
    const pin=await m.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.kind==='copy'?undefined:leaf.before));
    const fp=pin.fingerprint; await pin.close();
    if (leaf.kind!=='trash' && leaf.target && await m.exists(leaf.target)) {
      await m.rollbackPublication({ staged:leaf.stage,target:leaf.target,fingerprint:fp,rollback:leaf.stage+'-rollback-file' },p=>verify(p,leaf.hash!));
    }
    if (leaf.kind==='move' || leaf.kind==='trash') await m.recoverEviction({ source:leaf.source!,quarantine:leaf.stage,fingerprint:fp },p=>verify(p,leaf.hash!));
  }
}
