export type FilesSyncCaller={kind:'human'}|{kind:'agent';agentId:string};
export function requireHumanFilesSync(caller:FilesSyncCaller):void {
  if(caller.kind==='human')return;
  const error=Object.assign(new Error('Only the person using this desktop can change or restore Files Cloud backup.'),{code:'human_only',status:403});
  throw error;
}
