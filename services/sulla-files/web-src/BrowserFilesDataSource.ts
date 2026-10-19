import { fileAccessList, fileShare, filesItem, filesVersion, folderShare, type FilesApiCollection, type FilesApiFile, type FilesApiRecord } from './filesApiModels';
import { normalizeFilesIndexCoverage } from '../../../pkg/rancher-desktop/pages/files/types';

import type { FileAccessList, FilesDataSource, FileShare, FilesIndexCoverage, FilesItem, FilesPreview, FilesRetentionPolicy, FilesSnapshot, FilesVersion, FilesVersioningSettings, FolderShare } from '../../../pkg/rancher-desktop/pages/files/types';

export type ContainerCollection = FilesApiCollection;

function indexCoverage(files:FilesItem[]):FilesIndexCoverage {
  const coverage = { total: files.length, pending: 0, indexing: 0, indexed: 0, partial: 0, unsupported: 0, failed: 0, complete: true };

  for (const file of files) {
    coverage[file.indexStatus]++;
    if (file.indexStatus === 'indexed' && file.indexReasonCode?.endsWith('_partial')) coverage.partial++;
  }
  coverage.complete = coverage.pending === 0 && coverage.indexing === 0 && coverage.partial === 0 && coverage.unsupported === 0 && coverage.failed === 0;

  return coverage;
}

export class BrowserFilesDataSource implements FilesDataSource {
  readonly capabilities={upload:true,versionHistory:true,restoreVersions:true,trash:true,orgSharing:true,publicLinks:false,onlineOnly:false,nativeFilesystem:false,lifecycle:{updateLifecycle:false,checkout:false,checkin:false,publish:false,retention:false,record:false,disposal:false}};
  readonly onlineOnlyReason='Server files remain available from the server.';
  private controller=new AbortController();
  private readonly urls=new Set<string>();
  private files:FilesItem[]=[];
  private collectionId='';
  private collection:ContainerCollection|undefined;
  private generation=0;

  constructor(private token:string,private readonly accountName:string,private readonly orgId:string,private readonly expired:()=>void){}

  async availableCollections():Promise<ContainerCollection[]>{const collections=await this.request<ContainerCollection[]>('/v1/collections');if(collections.length)return collections;return[this.collection=await this.request<ContainerCollection>('/v1/collections/default',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orgId:this.orgId})})]}
  selectCollection(collection:ContainerCollection):void{const shares=Array.isArray(collection.shared_folders)?collection.shared_folders:[];const files=Array.isArray(collection.shared_files)?collection.shared_files:[];if(!collection.id||(!collection.access_role&&!shares.length&&!files.length))throw new Error('This collection is not available to your account.');const scopedRole=[...shares,...files].some((share:FilesApiRecord)=>share.role==='edit')?'edit':'view';const effectiveRole=collection.access_role??scopedRole;const canEdit=['edit','manage','owner'].includes(effectiveRole);const canManage=['manage','owner'].includes(effectiveRole);this.capabilities.upload=canEdit;this.capabilities.restoreVersions=canEdit;this.capabilities.trash=canEdit;this.capabilities.orgSharing=canManage;this.capabilities.lifecycle={updateLifecycle:canManage,checkout:canEdit,checkin:canEdit,publish:canEdit,retention:canManage,record:canManage,disposal:canManage};this.generation+=1;this.controller.abort();this.controller=new AbortController();for(const url of this.urls)URL.revokeObjectURL(url);this.urls.clear();this.collection=collection;this.collectionId=collection.id;this.files=[]}

  destroy():void{this.generation+=1;this.controller.abort();this.token='';this.files=[];for(const url of this.urls)URL.revokeObjectURL(url);this.urls.clear()}

  private async request<T>(path:string,options:RequestInit={},generation=this.generation):Promise<T>{
    if(!this.token)throw new Error('Files is locked. Sign in again.');
    const response=await fetch(`/files-api${path}`,{...options,cache:'no-store',credentials:'omit',signal:this.controller.signal,headers:{Authorization:`Bearer ${this.token}`,...(options.headers??{})}});
    if(generation!==this.generation)throw new DOMException('Stale Files request','AbortError');
    if(response.status===401){this.expired();throw new Error('Your Files session ended. Sign in again.')}
    if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};if(generation!==this.generation)throw new DOMException('Stale Files request','AbortError');throw new Error(body.error??`Files request failed (${response.status})`)}
    if(response.status===204)return undefined as T;
    const body=await response.json() as T;
    if(generation!==this.generation)throw new DOMException('Stale Files request','AbortError');
    return body;
  }

  async load():Promise<FilesSnapshot>{
    const generation=this.generation;
    const collection=this.collection;
    if(!collection)throw new Error('Choose a Files collection to continue.');
    this.collectionId=collection.id;
    const [active,trash]=await Promise.all([this.request<FilesApiFile[]>(`/v1/files?collectionId=${encodeURIComponent(collection.id)}`,{},generation),this.request<FilesApiFile[]>(`/v1/trash?collectionId=${encodeURIComponent(collection.id)}`,{},generation)]);
    if(generation!==this.generation)throw new DOMException('Stale Files request','AbortError');
    this.files=[...active,...trash].map(value=>filesItem(value));
    const shares=Array.isArray(collection.shared_folders)?collection.shared_folders:[];const files=Array.isArray(collection.shared_files)?collection.shared_files:[];const scopedRole=[...shares,...files].some((share:FilesApiRecord)=>share.role==='edit')?'file-or-folder-edit':shares.length||files.length?'file-or-folder-view':undefined;
    const indexing=indexCoverage(this.files.filter(file=>!file.deletedAt));
    return{collection:{id:collection.id,name:collection.name,home:collection.home??'/',orgId:collection.org_id,retentionPolicy:collection.retention_policy??{},storageQuota:collection.storage_quota===undefined?undefined:Number(collection.storage_quota),keptBytes:collection.kept_bytes===undefined?undefined:Number(collection.kept_bytes),desktopCount:collection.desktop_count===undefined?undefined:Number(collection.desktop_count),memberCount:collection.member_count===undefined?undefined:Number(collection.member_count),accountName:collection.account_display_name??this.accountName,accountRole:collection.access_role??scopedRole,ownerUserId:collection.owner_user_id,sharedFolders:shares.map((value:FilesApiRecord)=>value.folderPath??value.folder_path)},files:this.files,status:{state:'synced',pendingFiles:0,serverConfigured:true,location:'server',serverLabel:'Sulla Server',indexing}};
  }

  async history(fileId:string):Promise<FilesVersion[]>{const rows=await this.request<FilesApiRecord[]>(`/v1/files/${encodeURIComponent(fileId)}/history`);const current=this.files.find(file=>file.id===fileId)?.currentVersionId;return rows.map(row=>filesVersion(row,current))}
  async preview(fileId:string,versionId?:string):Promise<FilesPreview>{const generation=this.generation;const response=await this.binary(`/v1/files/${encodeURIComponent(fileId)}/preview${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,generation);const data=new Uint8Array(await response.arrayBuffer());this.assertCurrent(generation);return{data,mime:response.headers.get('content-type')??'application/octet-stream',path:this.files.find(file=>file.id===fileId)?.path??''}}
  detail(fileId:string):Promise<any>{return this.request(`/v1/files/${encodeURIComponent(fileId)}`)}
  async mediaUrl(fileId:string,versionId?:string):Promise<string>{const generation=this.generation;const response=await this.binary(`/v1/files/${encodeURIComponent(fileId)}/preview${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,generation);const blob=await response.blob();this.assertCurrent(generation);const mime=(blob.type||response.headers.get('content-type')||'').split(';',1)[0].toLowerCase();if(!mime.startsWith('image/')&&!mime.startsWith('audio/')&&!mime.startsWith('video/')&&mime!=='application/pdf')throw new Error('This file type cannot be previewed safely in the browser. Download it instead.');if(mime==='image/svg+xml'||mime==='text/html'||mime==='application/xhtml+xml')throw new Error('Executable document previews are blocked. Download the file instead.');const url=URL.createObjectURL(blob);this.assertCurrent(generation);this.urls.add(url);return url}
  async search(query:string):Promise<{files:FilesItem[];coverage:FilesIndexCoverage}>{const response=await this.request<{results:{id:string}[];coverage:FilesIndexCoverage}>('/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,collectionId:this.collectionId})});const byId=new Map(this.files.map(file=>[file.id,file]));return{files:response.results.map(row=>byId.get(row.id)).filter((file):file is FilesItem=>Boolean(file&&!file.deletedAt)),coverage:normalizeFilesIndexCoverage(response.coverage)}}
  reindex(fileId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/reindex`,{method:'POST'})}
  setPaused(_paused:boolean):Promise<FilesSnapshot['status']>{return Promise.resolve({state:'synced',pendingFiles:0,serverConfigured:true,location:'server',serverLabel:'Sulla Server',indexing:indexCoverage(this.files.filter(file=>!file.deletedAt))})}

  async chooseUpload(targetPath=''):Promise<number>{const generation=this.generation;const collectionId=this.collectionId;if(!collectionId)throw new Error('No Files collection is selected.');const files=await new Promise<File[]>(resolve=>{const input=document.createElement('input');let settled=false;const finish=()=>{if(settled)return;settled=true;window.removeEventListener('focus',onFocus);resolve([...(input.files??[])])};const onFocus=()=>setTimeout(finish,0);input.type='file';input.multiple=true;input.onchange=finish;window.addEventListener('focus',onFocus,{once:true});input.click()});this.assertCurrent(generation);if(this.collectionId!==collectionId)throw new DOMException('Files collection changed','AbortError');for(const file of files){this.assertCurrent(generation);if(this.collectionId!==collectionId)throw new DOMException('Files collection changed','AbortError');await this.upload(file,[targetPath,file.name].filter(Boolean).join('/'),generation,collectionId)}return files.length}
  uploadPaths(_paths:string[]):Promise<number>{return Promise.reject(new Error('Use Choose files in the browser to upload.'))}
  createFolder(_path:string):Promise<void>{return Promise.reject(new Error('Empty folders are not stored on Sulla Server. Upload a file into the folder instead.'))}
  openFolder():Promise<void>{return Promise.reject(new Error('This Files collection is hosted on Sulla Server.'))}
  async openFile(fileId:string,versionId?:string):Promise<void>{await this.downloadFile(fileId,this.files.find(file=>file.id===fileId)?.path.split('/').at(-1)??'download',versionId)}
  async downloadFile(fileId:string,name:string,versionId?:string):Promise<boolean>{const generation=this.generation;const response=await this.binary(`/v1/files/${encodeURIComponent(fileId)}/download${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,generation);const blob=await response.blob();this.assertCurrent(generation);const url=URL.createObjectURL(blob);this.assertCurrent(generation);this.urls.add(url);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>{URL.revokeObjectURL(url);this.urls.delete(url)},1000);return true}
  async downloadFiles(items:{fileId:string;name:string;versionId?:string}[]):Promise<{count:number;error?:string}>{let count=0;try{for(const item of items){await this.downloadFile(item.fileId,item.name,item.versionId);count+=1}return{count}}catch(error){return{count,error:error instanceof Error?error.message:'Download failed'}}}
  listStars(collectionId:string):Promise<{fileId?:string;folderPath?:string}[]>{return this.request(`/v1/stars?collectionId=${encodeURIComponent(collectionId)}`)}
  setStar(collectionId:string,target:{fileId?:string;folderPath?:string},starred:boolean):Promise<void>{return this.request('/v1/stars',{method:starred?'PUT':'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({collectionId,...target})})}
  operate(action:'move'|'copy',collectionId:string,items:{fileId?:string;folderPath?:string;targetPath:string}[]):Promise<void>{return this.request('/v1/file-operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,collectionId,items})})}
  async listFolderShares(collectionId:string):Promise<FolderShare[]>{const rows=await this.request<FilesApiRecord[]>(`/v1/collections/${encodeURIComponent(collectionId)}/shares`);return rows.map(row=>folderShare(row,collectionId))}
  async shareFolder(collectionId:string,folderPath:string,principalType:'user'|'group',principalId:string,role:'view'|'edit'):Promise<FolderShare>{const row=await this.request<FilesApiRecord>(`/v1/collections/${encodeURIComponent(collectionId)}/shares`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderPath,principalType,principalId,role})});return folderShare(row,collectionId,{folderPath,principalType,principalId,role})}
  unshareFolder(share:FolderShare):Promise<void>{return this.request(`/v1/collections/${encodeURIComponent(share.collectionId)}/shares`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderPath:share.folderPath,principalType:share.principalType,principalId:share.principalId})})}
  async listFileShares(fileId:string):Promise<FileAccessList>{const access=await this.request<FilesApiRecord>(`/v1/files/${encodeURIComponent(fileId)}/shares`);return fileAccessList(access,fileId,this.collectionId)}
  async shareFile(fileId:string,principalType:'user'|'group',principalId:string,role:'view'|'edit'):Promise<FileShare>{const row=await this.request<FilesApiRecord>(`/v1/files/${encodeURIComponent(fileId)}/shares`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({principalType,principalId,role})});return fileShare(row,fileId,{principalType,principalId,role})}
  async updateFileShare(fileId:string,shareId:string,role:'view'|'edit'):Promise<FileShare>{const row=await this.request<FilesApiRecord>(`/v1/files/${encodeURIComponent(fileId)}/shares/${encodeURIComponent(shareId)}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({role})});return fileShare(row,fileId)}
  unshareFile(fileId:string,shareId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/shares/${encodeURIComponent(shareId)}`,{method:'DELETE'})}
  listMembers(orgId:string):Promise<{members:{id:string;email:string;role:string}[];groups?:{id:string;name?:string;encrypted_name?:string;members?:string[]}[]}>{return this.request(`/v1/orgs/${encodeURIComponent(orgId)}/members`)}
  restoreVersion(fileId:string,versionId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionId})})}
  updateLifecycle(fileId:string,settings:FilesVersioningSettings):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/lifecycle`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(settings)})}
  checkout(fileId:string,force=false):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/checkout`,{method:force?'DELETE':'POST',headers:{'Content-Type':'application/json'},body:force?JSON.stringify({force}):undefined})}
  checkin(fileId:string,versionId:string,kind:'major'|'minor',comment:string,publish:boolean):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/checkin`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionId,kind,comment,publish})})}
  publishVersion(fileId:string,versionId:string,expectedDraftVersionId?:string|null,comment?:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/publish`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionId,expectedDraftVersionId,comment})})}
  updateRetention(fileId:string,policy:FilesRetentionPolicy):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/retention`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(policy)})}
  recordLock(fileId:string,status:'ordinary'|'policy'):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/record-lock`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind:status})})}
  unlockRecord(fileId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/record-lock`,{method:'DELETE'})}
  disposalReview(fileId:string,decision:'approve'|'reject'|'extend',extendedUntil?:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/disposal-review`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({decision,extendedUntil})})}
  restoreTrash(fileId:string):Promise<void>{return this.request(`/v1/trash/${encodeURIComponent(fileId)}/restore`,{method:'POST'})}
  trashFile(fileId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}`,{method:'DELETE'})}

  private async upload(file:File,path:string,generation=this.generation,collectionId=this.collectionId):Promise<void>{if(!collectionId)throw new Error('No Files collection is selected.');this.assertCurrent(generation);if(this.collectionId!==collectionId)throw new DOMException('Files collection changed','AbortError');const response=await fetch(`/files-api/v1/files/upload?collectionId=${encodeURIComponent(collectionId)}&path=${encodeURIComponent(path)}`,{method:'PUT',cache:'no-store',credentials:'omit',signal:this.controller.signal,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':file.type||'application/octet-stream'},body:file});this.assertCurrent(generation);if(this.collectionId!==collectionId)throw new DOMException('Files collection changed','AbortError');if(response.status===401){this.expired();throw new Error('Your Files session ended. Sign in again.')}if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};this.assertCurrent(generation);throw new Error(body.error??`Files request failed (${response.status})`)} }
  private assertCurrent(generation:number):void{if(generation!==this.generation||!this.token)throw new DOMException('Stale Files request','AbortError')}
  private async binary(path:string,generation=this.generation):Promise<Response>{const response=await fetch(`/files-api${path}`,{cache:'no-store',credentials:'omit',signal:this.controller.signal,headers:{Authorization:`Bearer ${this.token}`}});this.assertCurrent(generation);if(response.status===401){this.expired();throw new Error('Your Files session ended. Sign in again.')}if(!response.ok)throw new Error(`Files request failed (${response.status})`);return response}
}
