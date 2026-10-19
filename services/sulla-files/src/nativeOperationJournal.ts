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
interface CrossLeaf {
  kind:'publish'|'evict'|'relocate'|'mkdir'|'rmdir'; rootId:string;
  source?:string; target?:string; stage:string; fileId?:string; versionId?:string; hash?:string;
  before?:Fingerprint; published?:Fingerprint; directory?:DirectoryReceipt; started?:boolean; completed?:boolean;
  sourceRootId?:string;
}
interface CrossPlan {
  version:3; receiptId:string; sourceCollectionId:string; targetCollectionId:string; operationId:string; itemId:string;
  sourceRootId?:string; targetRootId?:string; leaves:CrossLeaf[]; watched:any[];
  committed?:Committed; inverseCommitted?:Committed; undoProgress?:number; grants?:any;
  sourceTree?:string; targetTrees?:string[]; absentAfter?:{rootId:string;path:string}[];
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
    private readonly verifyVersion:(fileId:string,versionId:string,hash:string)=>Promise<void>,
    private readonly readVersion:(fileId:string,versionId:string)=>Promise<AsyncIterable<Uint8Array>>) {}

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
    const targetCollection=receipt.request?.targetCollectionId;
    if (targetCollection && targetCollection!==receipt.collection_id) {
      if (undo) return this.inverseCross(client,receipt);
      return this.publishCross(client,receipt,targetCollection);
    }
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
      const displacedFileBefore=!folderPlan && receipt.displaced_before?.fileId ? receipt.displaced_before : null;
      const displacedFileAfter=displacedFileBefore && receipt.displaced_after?.fileId ? receipt.displaced_after : null;
      const watched=(await client.query('SELECT * FROM watched_folder_state WHERE file_id=ANY($1::uuid[]) FOR UPDATE',
        [[...records.map((r:any)=>r.before_state?.fileId),displacedFileBefore?.fileId].filter(Boolean)])).rows;
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
      if (displacedFileBefore) await fileLeaf(displacedFileBefore,displacedFileAfter,'move',`${prefix}/displaced`);
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
      if (displacedFileAfter) includeParents(displacedFileAfter.path);
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
      for (const w of watched) if (receipt.action!=='copy' || displacedFileIds.has(w.file_id) || w.file_id===displacedFileBefore?.fileId) await client.query('DELETE FROM watched_folder_state WHERE file_id=$1',[w.file_id]);
      for (const state of [...records.map((r:any)=>r.after_state),displacedFileAfter]) {
        if (!state?.fileId || state.deleted) continue;
        const leaf=plan.leaves.find(l=>l.target===state.path);
        if (!leaf?.published) throw failure();
        await this.watch(client,root,state.fileId,state.path,leaf.hash!,leaf.published);
      }
      plan.committed=await this.capture(client,receipt);
      await client.query("UPDATE files_path_operations SET state='db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
    });
  }

  private async publishCross(client:pg.PoolClient,receipt:any,targetCollectionId:string):Promise<void> {
    const source=await this.resolve(receipt.collection_id);
    const target=await this.resolve(targetCollectionId);
    if (!source && !target) return;
    const roots=[source,target].filter((root,index,items):root is NativeJournalRoot=>Boolean(root) && items.findIndex(item=>item?.id===root!.id)===index)
      .sort((left,right)=>left.id.localeCompare(right.id));
    const run=(index:number,operation:()=>Promise<void>):Promise<void>=>index===roots.length?operation():roots[index].mutations.runExclusive([],()=>run(index+1,operation));
    await run(0,async()=>{
      await FilesMutationCoordinator.requireAtomicRename();
      const itemId=receipt.request.itemId??receipt.id;
      const operationId=receipt.request.batchOperationId??receipt.id;
      const prefix=`.sulla-trash/.operations/${operationId}/${itemId}/${receipt.id}`;
      const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
      const incoming=(folderPlan?.children??[{before:receipt.before_state,after:receipt.after_state,action:receipt.action}]).map((item:any)=>({before:item.before??item.before_state,after:item.after??item.after_state,action:item.action??receipt.action}));
      const displaced=(folderPlan?.displaced?.children??(receipt.displaced_before?[{before:receipt.displaced_before,after:receipt.displaced_after,action:'rename'}]:[]))
        .map((item:any)=>({before:item.before??item.before_state,after:item.after??item.after_state,action:item.action??'rename'}));
      const ids=[...new Set<string>([...incoming,...displaced].flatMap(item=>[item.before?.fileId,item.after?.fileId]).filter(Boolean))];
      const watched=(await client.query('SELECT * FROM watched_folder_state WHERE file_id=ANY($1::uuid[]) FOR UPDATE',[ids])).rows;
      const plan:CrossPlan={version:3,receiptId:receipt.id,sourceCollectionId:receipt.collection_id,targetCollectionId,operationId,itemId,
        ...(source?{sourceRootId:source.id}:{}),...(target?{targetRootId:target.id}:{}),leaves:[],watched,
        ...(folderPlan?{sourceTree:folderPlan.source,targetTrees:[folderPlan.target,...(folderPlan.displaced?[folderPlan.displaced.target]:[])].filter(Boolean)}:{})};
      const rootById=(id:string)=>roots.find(root=>root.id===id)!;
      const addRelocate=async(record:any,index:number)=>{
        if (!target || !record.before?.fileId || !record.after?.fileId) return;
        const w=watched.find(row=>row.file_id===record.before.fileId && row.root_id===target.id && row.path===record.before.path);
        if (!w) return;
        await this.verifyVersion(record.before.fileId,record.before.versionId,w.content_hash);
        const pin=await target.mutations.pinVerified(record.before.path,p=>verify(p,w.content_hash));
        try { plan.leaves.push({kind:'relocate',rootId:target.id,source:record.before.path,target:record.after.path,stage:`${prefix}/displaced-${index}`,fileId:record.before.fileId,versionId:record.before.versionId,hash:w.content_hash,before:packed(pin.fingerprint)}) }
        finally { await pin.close() }
      };
      if (target && folderPlan?.displaced) {
        const desired=[...new Set<string>((folderPlan.displaced.folders??[]).map((item:any)=>item.after.path))].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
        for (const [index,path] of desired.entries()) if (!await target.mutations.exists(path)) plan.leaves.push({kind:'mkdir',rootId:target.id,target:path,stage:`${prefix}/displaced-dir-${index}`});
        for (const [index,record] of displaced.entries()) await addRelocate(record,index);
        for (const [index,item] of [...(folderPlan.displaced.folders??[])].reverse().entries()) {
          if (!await target.mutations.exists(item.before.path)) continue;
          plan.leaves.push({kind:'rmdir',rootId:target.id,source:item.before.path,stage:`${prefix}/displaced-rmdir-${index}`,directory:await target.mutations.directory(item.before.path)});
        }
      }
      if (target && folderPlan) {
        const desired=[...new Set<string>((folderPlan.folders??[]).filter((item:any)=>!item.deleted).map((item:any)=>item.after.path))].sort((a,b)=>a.split('/').length-b.split('/').length||a.localeCompare(b));
        for (const [index,path] of desired.entries()) {
          const replaced=folderPlan.displaced && (path===folderPlan.displaced.source || path.startsWith(folderPlan.displaced.source+'/'));
          if (replaced || !await target.mutations.exists(path)) plan.leaves.push({kind:'mkdir',rootId:target.id,target:path,stage:`${prefix}/target-dir-${index}`});
        }
      }
      for (const [index,record] of incoming.entries()) {
        const sourceWatch=source&&watched.find(row=>row.file_id===record.before?.fileId && row.root_id===source.id && row.path===record.before.path);
        let sourceFingerprint:Fingerprint|undefined;
        if (sourceWatch) {
          const pin=await source!.mutations.pinVerified(record.before.path,p=>verify(p,sourceWatch.content_hash));
          try { sourceFingerprint=packed(pin.fingerprint) } finally { await pin.close() }
        }
        if (target && record.after?.fileId && !record.after.deleted) plan.leaves.push({kind:'publish',rootId:target.id,sourceRootId:sourceWatch?source!.id:undefined,
          source:record.before.path,target:record.after.path,stage:`${prefix}/incoming-${index}`,fileId:record.before.fileId,versionId:record.before.versionId,
          ...(sourceWatch?{hash:sourceWatch.content_hash,before:sourceFingerprint}:{})});
        if (sourceWatch && receipt.action!=='copy') {
          const pin=await source!.mutations.pinVerified(record.before.path,p=>verify(p,sourceWatch.content_hash));
          try { plan.leaves.push({kind:'evict',rootId:source!.id,source:record.before.path,stage:`${prefix}/source-${index}`,fileId:record.before.fileId,versionId:record.before.versionId,hash:sourceWatch.content_hash,before:packed(pin.fingerprint)}) }
          finally { await pin.close() }
        }
      }
      if (source && folderPlan && receipt.action!=='copy') for (const [index,item] of [...(folderPlan.folders??[])].reverse().entries()) {
        if (!await source.mutations.exists(item.before.path)) continue;
        plan.leaves.push({kind:'rmdir',rootId:source.id,source:item.before.path,stage:`${prefix}/source-dir-${index}`,directory:await source.mutations.directory(item.before.path)});
      }
      await this.db.query(`INSERT INTO files_path_operations(operation_id,action,state,plan) VALUES($1,$2,'planned',$3)`,[receipt.id,receipt.action,plan]);
      await this.db.query("UPDATE files_path_operations SET state='publishing' WHERE operation_id=$1",[receipt.id]);
      for (const leaf of plan.leaves) {
        assertOperationNotCancelled(operationId);
        const root=rootById(leaf.rootId);
        if (leaf.kind==='publish') await this.stageCrossLeaf(plan,leaf,root,source);
        if (leaf.kind==='mkdir') {
          const staged=await root.mutations.stageDirectory(leaf.stage); leaf.directory={...staged,path:leaf.target!};
          await this.save(receipt.id,plan);
        }
        leaf.started=true; await this.save(receipt.id,plan);
        await this.forwardCross(leaf,root);
        leaf.completed=true; await this.save(receipt.id,plan);
      }
      assertOperationNotCancelled(operationId);
      for (const record of displaced) if (record.before?.fileId) await client.query('DELETE FROM watched_folder_state WHERE file_id=$1',[record.before.fileId]);
      if (receipt.action!=='copy') for (const record of incoming) if (record.before?.fileId) await client.query('DELETE FROM watched_folder_state WHERE file_id=$1',[record.before.fileId]);
      for (const record of [...incoming,...displaced]) {
        if (!target || !record.after?.fileId || record.after.deleted) continue;
        const leaf=plan.leaves.find(item=>item.target===record.after.path && ['publish','relocate'].includes(item.kind));
        if (!leaf?.published || !leaf.hash) throw failure();
        await this.watch(client,target,record.after.fileId,record.after.path,leaf.hash,leaf.published);
      }
      plan.grants=this.receiptGrants(receipt);
      plan.committed=await this.capture(client,receipt);
      await client.query("UPDATE files_path_operations SET state='db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
    });
  }

  private async stageCrossLeaf(plan:CrossPlan,leaf:CrossLeaf,target:NativeJournalRoot,source:NativeJournalRoot|null):Promise<void> {
    if (await target.mutations.exists(leaf.stage)) throw failure();
    const output=await target.mutations.openPrivateExclusive(leaf.stage); const digest=createHash('sha256');
    try {
      const write=async(stream:AsyncIterable<Uint8Array>)=>{ for await (const value of stream) { const bytes=Buffer.from(value); digest.update(bytes); let offset=0; while (offset<bytes.length) { const result=await output.write(bytes,offset); if (!result.bytesWritten) throw failure(); offset+=result.bytesWritten } } };
      if (leaf.sourceRootId) {
        if (!source || source.id!==leaf.sourceRootId) throw failure();
        const pin=await source.mutations.pinVerified(leaf.source!,p=>verify(p,leaf.hash!,leaf.before));
        try { await write(pin.createReadStream()); await pin.assertUnchanged() } finally { await pin.close() }
      } else await write(await this.readVersion(leaf.fileId!,leaf.versionId!));
      await output.sync();
    } finally { await output.close() }
    const hash=digest.digest('hex'); if (leaf.hash && leaf.hash!==hash) throw failure(); leaf.hash=hash;
    const staged=await target.mutations.pinVerified(leaf.stage,p=>verify(p,hash)); try { leaf.before=packed(staged.fingerprint) } finally { await staged.close() }
    await this.save(plan.receiptId,plan);
  }

  private async forwardCross(leaf:CrossLeaf,root:NativeJournalRoot):Promise<void> {
    if (leaf.kind==='mkdir') { leaf.directory=await root.mutations.restoreEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='rmdir') { await root.mutations.evictEmptyDirectory(leaf.directory!,leaf.stage); return }
    if (leaf.kind==='publish') { const published=await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)}); leaf.published=packed(published.fingerprint); return }
    const pin=await root.mutations.pinVerified(leaf.source!,p=>verify(p,leaf.hash!,leaf.before)); try { leaf.before=packed(pin.fingerprint) } finally { await pin.close() }
    await root.mutations.evictVerified({source:leaf.source!,quarantine:leaf.stage,verify:p=>verify(p,leaf.hash!,leaf.before)});
    if (leaf.kind==='relocate') { const published=await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)}); leaf.published=packed(published.fingerprint) }
  }

  private async crossRoots(plan:CrossPlan):Promise<Map<string,NativeJournalRoot>> {
    const roots=new Map<string,NativeJournalRoot>();
    for (const collectionId of [plan.sourceCollectionId,plan.targetCollectionId]) {
      const root=await this.resolve(collectionId); if (root) roots.set(root.id,root);
    }
    for (const id of [plan.sourceRootId,plan.targetRootId].filter(Boolean)) if (!roots.has(id!)) throw failure();
    return roots;
  }

  private async validateCrossFilesystem(plan:CrossPlan,undo=false):Promise<void> {
    const roots=await this.crossRoots(plan);
    for (const leaf of plan.leaves) {
      const root=roots.get(leaf.rootId); if (!root || !leaf.completed) throw failure();
      if (leaf.kind==='mkdir') {
        if (undo) {
          const restored=plan.leaves.find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='rmdir' && candidate.source===leaf.target);
          if (restored) {
            const directory=await root.mutations.directory(leaf.target!);
            if (directory.dev!==restored.directory?.dev || directory.ino!==restored.directory?.ino) throw failure();
          } else if (await root.mutations.exists(leaf.target!)) throw failure();
          const retained=await root.mutations.directory(leaf.stage+'.undo');
          if (retained.dev!==leaf.directory?.dev || retained.ino!==leaf.directory?.ino) throw failure();
          continue;
        }
        const directory=await root.mutations.directory(leaf.target!); if (directory.dev!==leaf.directory?.dev || directory.ino!==leaf.directory?.ino) throw failure();
      } else if (leaf.kind==='rmdir') {
        const path=undo?leaf.source!:leaf.stage; const directory=await root.mutations.directory(path);
        if (directory.dev!==leaf.directory?.dev || directory.ino!==leaf.directory?.ino) throw failure();
      } else if (undo) {
        if (leaf.source && ['evict','relocate'].includes(leaf.kind)) { const pin=await root.mutations.pinVerified(leaf.source,p=>verify(p,leaf.hash!,leaf.before)); await pin.close() }
        if (leaf.target && ['publish','relocate'].includes(leaf.kind) && await root.mutations.exists(leaf.target)) throw failure();
        if (['publish','relocate'].includes(leaf.kind)) { const retained=await root.mutations.pinVerified(leaf.stage+'.undo',p=>verify(p,leaf.hash!,leaf.published)); await retained.close() }
      } else {
        const stage=await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.before)); await stage.close();
        if (leaf.target) { const target=await root.mutations.pinVerified(leaf.target,p=>verify(p,leaf.hash!,leaf.published)); await target.close() }
        if (leaf.kind==='evict' && await root.mutations.exists(leaf.source!)) throw failure();
      }
    }
  }

  private async verifyCrossCommitted(plan:CrossPlan,undo:boolean):Promise<void> {
    const expected=undo?plan.inverseCommitted:plan.committed;
    if (!expected) throw failure();
    const actual=await this.captureIds(this.db,expected.fileIds,expected.folderIds);
    if (expected.grants) actual.grants=await this.captureGrants(this.db,plan.grants);
    if (canonical(expected)!==canonical(actual)) throw failure();
    await this.validateCrossFilesystem(plan,undo);
  }

  private async inverseCross(client:pg.PoolClient,receipt:any):Promise<void> {
    const row=(await this.db.query('SELECT * FROM files_path_operations WHERE operation_id=$1',[receipt.id])).rows[0];
    if (!row || row.plan?.version!==3 || !['completed','db-committed'].includes(row.state)) throw failure();
    const plan=row.plan as CrossPlan; await this.validateCrossFilesystem(plan,false);
    const roots=await this.crossRoots(plan); plan.undoProgress=0;
    await this.db.query("UPDATE files_path_operations SET state='undo-planned',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
    await this.db.query("UPDATE files_path_operations SET state='undo-publishing' WHERE operation_id=$1",[receipt.id]);
    const reverse=[...plan.leaves].reverse();
    for (const leaf of reverse) {
      const root=roots.get(leaf.rootId)!; const undoStage=leaf.stage+'.undo';
      if (leaf.kind==='rmdir') await root.mutations.restoreEmptyDirectory(leaf.directory!,leaf.stage);
      else if (leaf.kind==='mkdir') await root.mutations.evictEmptyDirectory(leaf.directory!,undoStage);
      else if (leaf.kind==='evict') await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:{dev:BigInt(leaf.before!.dev),ino:BigInt(leaf.before!.ino),size:leaf.before!.size,mtimeMs:leaf.before!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.before));
      else if (leaf.kind==='publish') await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:undoStage,fingerprint:{dev:BigInt(leaf.published!.dev),ino:BigInt(leaf.published!.ino),size:leaf.published!.size,mtimeMs:leaf.published!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.published));
      else {
        await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:undoStage,fingerprint:{dev:BigInt(leaf.published!.dev),ino:BigInt(leaf.published!.ino),size:leaf.published!.size,mtimeMs:leaf.published!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.published));
        await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:{dev:BigInt(leaf.before!.dev),ino:BigInt(leaf.before!.ino),size:leaf.before!.size,mtimeMs:leaf.before!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.before));
      }
      plan.undoProgress=(plan.undoProgress??0)+1; await this.save(receipt.id,plan);
    }
    const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
    const afterStates=folderPlan?[...folderPlan.children,...(folderPlan.displaced?.children??[])].map((item:any)=>item.after):[receipt.after_state,receipt.displaced_after];
    for (const state of afterStates) if (state?.fileId) await client.query('DELETE FROM watched_folder_state WHERE file_id=$1',[state.fileId]);
    for (const watched of plan.watched) {
      const root=roots.get(watched.root_id); if (!root) throw failure();
      const pin=await root.mutations.pinVerified(watched.path,p=>verify(p,watched.content_hash));
      try { await this.watch(client,root,watched.file_id,watched.path,watched.content_hash,packed(pin.fingerprint)) } finally { await pin.close() }
    }
    plan.inverseCommitted=await this.capture(client,receipt);
    await client.query("UPDATE files_path_operations SET state='undo-db-committed',plan=$2,updated_at=NOW() WHERE operation_id=$1",[receipt.id,plan]);
  }

  private async rollbackCrossForward(plan:CrossPlan):Promise<void> {
    const roots=await this.crossRoots(plan);
    for (const leaf of [...plan.leaves].reverse().filter(item=>item.started || item.completed)) {
      const root=roots.get(leaf.rootId)!;
      if (leaf.kind==='mkdir') await root.mutations.evictEmptyDirectory(leaf.directory!,leaf.stage+'.rollback');
      else if (leaf.kind==='rmdir') await root.mutations.restoreEmptyDirectory(leaf.directory!,leaf.stage);
      else if (leaf.kind==='publish') await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:leaf.stage+'.rollback',fingerprint:{dev:BigInt(leaf.published!.dev),ino:BigInt(leaf.published!.ino),size:leaf.published!.size,mtimeMs:leaf.published!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.published));
      else if (leaf.kind==='evict') await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:{dev:BigInt(leaf.before!.dev),ino:BigInt(leaf.before!.ino),size:leaf.before!.size,mtimeMs:leaf.before!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.before));
      else {
        await root.mutations.rollbackPublication({staged:leaf.stage,target:leaf.target!,rollback:leaf.stage+'.rollback',fingerprint:{dev:BigInt(leaf.published!.dev),ino:BigInt(leaf.published!.ino),size:leaf.published!.size,mtimeMs:leaf.published!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.published));
        await root.mutations.recoverEviction({source:leaf.source!,quarantine:leaf.stage,fingerprint:{dev:BigInt(leaf.before!.dev),ino:BigInt(leaf.before!.ino),size:leaf.before!.size,mtimeMs:leaf.before!.mtimeMs}},p=>verify(p,leaf.hash!,leaf.before));
      }
    }
  }

  /** Return a partially published inverse to its exact committed-forward state. */
  private async rollbackCrossUndo(plan:CrossPlan):Promise<void> {
    const roots=await this.crossRoots(plan);
    // Reconcile every leaf in original order. Leaves not yet inverted are
    // already exact no-ops; leaves interrupted at any inverse boundary are
    // driven back to the durable forward identity without guessing ownership.
    for (const leaf of plan.leaves) {
      const root=roots.get(leaf.rootId); if (!root) throw failure();
      const undoStage=leaf.stage+'.undo';
      if (leaf.kind==='rmdir') {
        if (await root.mutations.exists(leaf.stage)) {
          const retained=await root.mutations.directory(leaf.stage);
          if (retained.dev!==leaf.directory?.dev || retained.ino!==leaf.directory?.ino) throw failure();
          if (await root.mutations.exists(leaf.source!)) {
            const replacement=plan.leaves.slice(plan.leaves.indexOf(leaf)+1).find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='mkdir' && candidate.target===leaf.source);
            const current=await root.mutations.directory(leaf.source!);
            if (!replacement?.directory || current.dev!==replacement.directory.dev || current.ino!==replacement.directory.ino) throw failure();
          }
        } else await root.mutations.evictEmptyDirectory(leaf.directory!,leaf.stage);
      } else if (leaf.kind==='mkdir') {
        if (await root.mutations.exists(leaf.target!)) {
          const current=await root.mutations.directory(leaf.target!);
          if (current.dev!==leaf.directory?.dev || current.ino!==leaf.directory?.ino) throw failure();
        } else await root.mutations.restoreEmptyDirectory(leaf.directory!,undoStage);
      } else if (leaf.kind==='evict') {
        if (await root.mutations.exists(leaf.stage)) {
          const retained=await root.mutations.pinVerified(leaf.stage,p=>verify(p,leaf.hash!,leaf.before)); await retained.close();
          if (await root.mutations.exists(leaf.source!)) throw failure();
        } else await root.mutations.evictVerified({source:leaf.source!,quarantine:leaf.stage,verify:p=>verify(p,leaf.hash!,leaf.before)});
      } else if (leaf.kind==='publish') {
        if (await root.mutations.exists(leaf.target!)) {
          const target=await root.mutations.pinVerified(leaf.target!,p=>verify(p,leaf.hash!,leaf.published)); await target.close();
        } else {
          const published=await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)});
          if (!same(packed(published.fingerprint),leaf.published!)) throw failure();
        }
      } else {
        if (!await root.mutations.exists(leaf.stage)) await root.mutations.evictVerified({source:leaf.source!,quarantine:leaf.stage,verify:p=>verify(p,leaf.hash!,leaf.before)});
        else if (await root.mutations.exists(leaf.source!)) {
          const replacement=plan.leaves.slice(plan.leaves.indexOf(leaf)+1).find(candidate=>candidate.rootId===leaf.rootId && candidate.kind==='publish' && candidate.target===leaf.source);
          if (!replacement?.published) throw failure();
          const current=await root.mutations.pinVerified(leaf.source!,p=>verify(p,replacement.hash!,replacement.published)); await current.close();
        }
        if (await root.mutations.exists(leaf.target!)) {
          const target=await root.mutations.pinVerified(leaf.target!,p=>verify(p,leaf.hash!,leaf.published)); await target.close();
        } else {
          const published=await root.mutations.publishVerified({staged:leaf.stage,target:leaf.target!,verify:p=>verify(p,leaf.hash!,leaf.before)});
          if (!same(packed(published.fingerprint),leaf.published!)) throw failure();
        }
      }
      plan.undoProgress=0;
      await this.save(plan.receiptId,plan);
    }
  }

  private async recoverCross(row:any):Promise<void> {
    const plan=row.plan as CrossPlan;
    if (row.state==='db-committed') { await this.verifyCrossCommitted(plan,false); await this.db.query("UPDATE files_path_operations SET state='completed',last_error=NULL,updated_at=NOW() WHERE operation_id=$1",[row.operation_id]); return }
    if (row.state==='undo-db-committed') { await this.verifyCrossCommitted(plan,true); await this.db.query("UPDATE files_path_operations SET state='undone',last_error=NULL,updated_at=NOW() WHERE operation_id=$1",[row.operation_id]); return }
    if (row.state==='planned' || row.state==='publishing') {
      await this.rollbackCrossForward(plan); await this.db.query("UPDATE files_path_operations SET state='rolled-back',last_error=NULL,updated_at=NOW() WHERE operation_id=$1",[row.operation_id]); return;
    }
    if (row.state==='undo-planned' || row.state==='undo-publishing') {
      await this.rollbackCrossUndo(plan); await this.verifyCrossCommitted(plan,false);
      await this.db.query("UPDATE files_path_operations SET state='completed',plan=$2,last_error=NULL,updated_at=NOW() WHERE operation_id=$1",[row.operation_id,plan]); return;
    }
    throw failure();
  }

  private async watch(client:pg.PoolClient,root:NativeJournalRoot,fileId:string,path:string,hash:string,fp:Fingerprint):Promise<void> {
    await client.query(`INSERT INTO watched_folder_state(collection_id,path,file_id,content_hash,size,mtime_ms,root_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(collection_id,path) DO UPDATE SET file_id=EXCLUDED.file_id,content_hash=EXCLUDED.content_hash,size=EXCLUDED.size,mtime_ms=EXCLUDED.mtime_ms,root_id=EXCLUDED.root_id`,
    [root.collectionId,path,fileId,hash,fp.size,fp.mtimeMs,root.id]);
  }

  private async save(id:string,plan:Plan|CrossPlan):Promise<void> {
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
    const displacedFileId=!folderPlan ? receipt.displaced_before?.fileId : undefined;
    for (const w of plan.watched) {
      if (receipt.action==='copy' && !displacedFileIds.has(w.file_id) && w.file_id!==displacedFileId) continue;
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
    const grants=this.receiptGrants(receipt);
    if (grants) committed.grants=await this.captureGrants(client,grants);
    return committed;
  }

  private receiptGrants(receipt:any):any|undefined {
    const folderPlan=receipt.folder_plan?.source?receipt.folder_plan:null;
    const groups=[folderPlan?.displaced?.grants,folderPlan?.transferredGrants].filter(Boolean);
    if (!groups.length) return undefined;
    return {
      folderShares:groups.flatMap((group:any)=>group.folderShares??[]),
      publicLinks:groups.flatMap((group:any)=>group.publicLinks??[]),
      fileIds:[...new Set<string>(groups.flatMap((group:any)=>group.fileIds??[]))],
    };
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
    const directoryPath=(leaf:Leaf):string|undefined => leaf.kind==='mkdir' ? leaf.target
      : ['rmdir','restore-dir'].includes(leaf.kind) ? leaf.directory?.path : undefined;
    const finalDirectoryOperations=new Map<string,Leaf>();
    for (const leaf of leaves) {
      const path=directoryPath(leaf);
      if (path) finalDirectoryOperations.set(path,leaf);
    }
    for (const leaf of leaves) {
      if (leaf.kind==='mkdir' || leaf.kind==='restore-dir') {
        const path=directoryPath(leaf)!;
        const finalOperation=finalDirectoryOperations.get(path);
        if (finalOperation===leaf) {
          const actual=await root.mutations.directory(path);
          if (actual.dev!==leaf.directory!.dev || actual.ino!==leaf.directory!.ino) throw failure();
        } else if (finalOperation?.kind!=='rmdir' || finalOperation.directory?.dev!==leaf.directory!.dev || finalOperation.directory?.ino!==leaf.directory!.ino) {
          throw failure();
        }
      } else if (leaf.kind==='rmdir') {
        const retained=await root.mutations.directory(leaf.stage);
        if (retained.dev!==leaf.directory!.dev || retained.ino!==leaf.directory!.ino) throw failure();
        const tree=await root.mutations.inspectTree(leaf.stage);
        if (tree.files.length || tree.directories.length!==1) throw failure();
        const replacement=finalDirectoryOperations.get(leaf.directory!.path);
        if (replacement===leaf) {
          if (await root.mutations.exists(leaf.directory!.path)) throw failure();
        } else {
          if (!replacement || !['mkdir','restore-dir'].includes(replacement.kind) || !replacement.directory) throw failure();
          const published=await root.mutations.directory(leaf.directory!.path);
          if (published.dev!==replacement.directory.dev || published.ino!==replacement.directory.ino) throw failure();
        }
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
    if (row.plan?.version===3) return this.recoverCross(row);
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
