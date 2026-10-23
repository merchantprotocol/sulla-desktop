export type FilesLiveEvent = {type:'sync';message:string} | {type:'presence';peers:{id:string;name:string;kind:string}[]} | {type:'error';error:string};
export type FilesLiveJoin = {peerId:string;editable:boolean;versionId:string};
export interface FilesLiveConnection { join:FilesLiveJoin; sync(message:string):Promise<{message:string|null}>; close():Promise<void> }
