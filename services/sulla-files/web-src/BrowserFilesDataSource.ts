import type { FilesDataSource, FilesItem, FilesPreview, FilesSnapshot, FilesVersion, FolderShare } from '../../../pkg/rancher-desktop/pages/files/types';

type Json=Record<string,any>;
export interface ContainerCollection extends Json { id:string;name:string;kind:string;access_role?:string;owner_user_id?:string }
interface ContainerFile extends Json { id:string;path:string;current_version_id:string }

export class BrowserFilesDataSource implements FilesDataSource {
  readonly capabilities={upload:true,versionHistory:true,restoreVersions:true,trash:true,orgSharing:true,publicLinks:false,onlineOnly:false,nativeFilesystem:false} as const;
  readonly onlineOnlyReason='Server files remain available from the server.';
  private readonly controller=new AbortController();
  private readonly urls=new Set<string>();
  private files:FilesItem[]=[];
  private collectionId='';
  private collection:ContainerCollection|undefined;
  private generation=0;

  constructor(private token:string,private readonly accountName:string,private readonly expired:()=>void){}

  async availableCollections():Promise<ContainerCollection[]>{const collections=await this.request<ContainerCollection[]>('/v1/collections');if(collections.length)return collections;return[this.collection=await this.request<ContainerCollection>('/v1/collections/default',{method:'POST'})]}
  selectCollection(collection:ContainerCollection):void{if(!collection.id||!collection.access_role)throw new Error('This collection is not available to your account.');this.collection=collection;this.collectionId=collection.id;this.files=[]}

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

  private item(file:ContainerFile):FilesItem{return{id:file.id,path:file.path,mime:file.mime??'application/octet-stream',size:Number(file.size??0),updatedAt:file.updated_at??new Date(0).toISOString(),deletedAt:file.deleted_at,currentVersionId:file.current_version_id,versionCount:Number(file.version_count??1),createdByType:file.created_by_type??file.version_created_by_type??'user',createdById:file.created_by_id??file.version_created_by_id??'',ownerDisplayName:file.owner_display_name,ownerAvatarUrl:file.owner_avatar_url,syncState:file.sync_state??'synced',conflictDevices:file.conflict_devices===undefined?undefined:Number(file.conflict_devices)}}

  async load():Promise<FilesSnapshot>{
    const generation=this.generation;
    const collection=this.collection;
    if(!collection)throw new Error('Choose a Files collection to continue.');
    this.collectionId=collection.id;
    const [active,trash]=await Promise.all([this.request<ContainerFile[]>(`/v1/files?collectionId=${encodeURIComponent(collection.id)}`,{},generation),this.request<ContainerFile[]>(`/v1/trash?collectionId=${encodeURIComponent(collection.id)}`,{},generation)]);
    if(generation!==this.generation)throw new DOMException('Stale Files request','AbortError');
    this.files=[...active,...trash].map(value=>this.item(value));
    return{collection:{id:collection.id,name:collection.name,home:collection.home??'/',orgId:collection.org_id,retentionPolicy:collection.retention_policy??{trashDays:90},storageQuota:collection.storage_quota===undefined?undefined:Number(collection.storage_quota),keptBytes:collection.kept_bytes===undefined?undefined:Number(collection.kept_bytes),desktopCount:collection.desktop_count===undefined?undefined:Number(collection.desktop_count),memberCount:collection.member_count===undefined?undefined:Number(collection.member_count),accountName:collection.account_display_name??this.accountName,accountRole:collection.access_role,ownerUserId:collection.owner_user_id,sharedFolders:collection.shared_folders?.map((value:Json)=>value.folderPath)},files:this.files,status:{state:'synced',pendingFiles:0,serverConfigured:true,location:'server',serverLabel:'Sulla Server'}};
  }

  async history(fileId:string):Promise<FilesVersion[]>{const rows=await this.request<Omit<FilesVersion,'current'>[]>(`/v1/files/${encodeURIComponent(fileId)}/history`);const current=this.files.find(file=>file.id===fileId)?.currentVersionId;return rows.map(row=>({...row,current:row.id===current}))}
  async preview(fileId:string,versionId?:string):Promise<FilesPreview>{const generation=this.generation;const response=await this.binary(`/v1/files/${encodeURIComponent(fileId)}/preview${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,generation);const data=new Uint8Array(await response.arrayBuffer());this.assertCurrent(generation);return{data,mime:response.headers.get('content-type')??'application/octet-stream',path:this.files.find(file=>file.id===fileId)?.path??''}}
  detail(fileId:string):Promise<any>{return this.request(`/v1/files/${encodeURIComponent(fileId)}`)}
  async mediaUrl(fileId:string,versionId?:string):Promise<string>{const generation=this.generation;const response=await this.binary(`/v1/files/${encodeURIComponent(fileId)}/preview${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,generation);const blob=await response.blob();this.assertCurrent(generation);const mime=(blob.type||response.headers.get('content-type')||'').split(';',1)[0].toLowerCase();if(!mime.startsWith('image/')&&!mime.startsWith('audio/')&&!mime.startsWith('video/')&&mime!=='application/pdf')throw new Error('This file type cannot be previewed safely in the browser. Download it instead.');if(mime==='image/svg+xml'||mime==='text/html'||mime==='application/xhtml+xml')throw new Error('Executable document previews are blocked. Download the file instead.');const url=URL.createObjectURL(blob);this.assertCurrent(generation);this.urls.add(url);return url}
  async search(query:string):Promise<FilesItem[]>{const rows=await this.request<{id:string}[]>('/v1/search',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query,collectionId:this.collectionId})});const byId=new Map(this.files.map(file=>[file.id,file]));return rows.map(row=>byId.get(row.id)).filter((file):file is FilesItem=>Boolean(file&&!file.deletedAt))}
  setPaused(_paused:boolean):Promise<FilesSnapshot['status']>{return Promise.resolve({state:'synced',pendingFiles:0,serverConfigured:true,location:'server',serverLabel:'Sulla Server'})}

  async chooseUpload(targetPath=''):Promise<number>{const files=await new Promise<File[]>(resolve=>{const input=document.createElement('input');let settled=false;const finish=()=>{if(settled)return;settled=true;window.removeEventListener('focus',onFocus);resolve([...(input.files??[])])};const onFocus=()=>setTimeout(finish,0);input.type='file';input.multiple=true;input.onchange=finish;window.addEventListener('focus',onFocus,{once:true});input.click()});for(const file of files)await this.upload(file,[targetPath,file.name].filter(Boolean).join('/'));return files.length}
  uploadPaths(_paths:string[]):Promise<number>{return Promise.reject(new Error('Use Choose files in the browser to upload.'))}
  createFolder(_path:string):Promise<void>{return Promise.reject(new Error('Empty folders are not stored on Sulla Server. Upload a file into the folder instead.'))}
  openFolder():Promise<void>{return Promise.reject(new Error('This Files collection is hosted on Sulla Server.'))}
  async openFile(fileId:string,versionId?:string):Promise<void>{await this.downloadFile(fileId,this.files.find(file=>file.id===fileId)?.path.split('/').at(-1)??'download',versionId)}
  async downloadFile(fileId:string,name:string,versionId?:string):Promise<boolean>{const generation=this.generation;const response=await this.binary(`/v1/files/${encodeURIComponent(fileId)}/download${versionId?`?versionId=${encodeURIComponent(versionId)}`:''}`,generation);const blob=await response.blob();this.assertCurrent(generation);const url=URL.createObjectURL(blob);this.assertCurrent(generation);this.urls.add(url);const link=document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(()=>{URL.revokeObjectURL(url);this.urls.delete(url)},1000);return true}
  async downloadFiles(items:{fileId:string;name:string;versionId?:string}[]):Promise<{count:number;error?:string}>{let count=0;try{for(const item of items){await this.downloadFile(item.fileId,item.name,item.versionId);count+=1}return{count}}catch(error){return{count,error:error instanceof Error?error.message:'Download failed'}}}
  listStars(collectionId:string):Promise<{fileId?:string;folderPath?:string}[]>{return this.request(`/v1/stars?collectionId=${encodeURIComponent(collectionId)}`)}
  setStar(collectionId:string,target:{fileId?:string;folderPath?:string},starred:boolean):Promise<void>{return this.request('/v1/stars',{method:starred?'PUT':'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({collectionId,...target})})}
  operate(action:'move'|'copy',collectionId:string,items:{fileId?:string;folderPath?:string;targetPath:string}[]):Promise<void>{return this.request('/v1/file-operations',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,collectionId,items})})}
  async listFolderShares(collectionId:string):Promise<FolderShare[]>{const rows=await this.request<Json[]>(`/v1/collections/${encodeURIComponent(collectionId)}/shares`);return rows.map(row=>({id:row.id,collectionId:row.collection_id,folderPath:row.folder_path,principalType:row.principal_type,principalId:row.principal_id,principalName:row.principal_name,role:row.role}))}
  shareFolder(collectionId:string,folderPath:string,principalType:'user'|'group',principalId:string,role:'view'|'edit'):Promise<FolderShare>{return this.request(`/v1/collections/${encodeURIComponent(collectionId)}/shares`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderPath,principalType,principalId,role})})}
  unshareFolder(share:FolderShare):Promise<void>{return this.request(`/v1/collections/${encodeURIComponent(share.collectionId)}/shares`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({folderPath:share.folderPath,principalType:share.principalType,principalId:share.principalId})})}
  listMembers(orgId:string):Promise<{members:{id:string;email:string;role:string}[];groups?:{id:string;name?:string;encrypted_name?:string;members?:string[]}[]}>{return this.request(`/v1/orgs/${encodeURIComponent(orgId)}/members`)}
  restoreVersion(fileId:string,versionId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}/restore`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({versionId})})}
  restoreTrash(fileId:string):Promise<void>{return this.request(`/v1/trash/${encodeURIComponent(fileId)}/restore`,{method:'POST'})}
  trashFile(fileId:string):Promise<void>{return this.request(`/v1/files/${encodeURIComponent(fileId)}`,{method:'DELETE'})}

  private async upload(file:File,path:string):Promise<void>{if(!this.collectionId)throw new Error('No Files collection is selected.');const generation=this.generation;const response=await fetch(`/files-api/v1/files/upload?collectionId=${encodeURIComponent(this.collectionId)}&path=${encodeURIComponent(path)}`,{method:'PUT',cache:'no-store',credentials:'omit',signal:this.controller.signal,headers:{Authorization:`Bearer ${this.token}`,'Content-Type':file.type||'application/octet-stream'},body:file});this.assertCurrent(generation);if(response.status===401){this.expired();throw new Error('Your Files session ended. Sign in again.')}if(!response.ok){const body=await response.json().catch(()=>({})) as {error?:string};this.assertCurrent(generation);throw new Error(body.error??`Upload failed (${response.status})`)} }
  private assertCurrent(generation:number):void{if(generation!==this.generation||!this.token)throw new DOMException('Stale Files request','AbortError')}
  private async binary(path:string,generation=this.generation):Promise<Response>{const response=await fetch(`/files-api${path}`,{cache:'no-store',credentials:'omit',signal:this.controller.signal,headers:{Authorization:`Bearer ${this.token}`}});this.assertCurrent(generation);if(response.status===401){this.expired();throw new Error('Your Files session ended. Sign in again.')}if(!response.ok)throw new Error(`Files request failed (${response.status})`);return response}
}
