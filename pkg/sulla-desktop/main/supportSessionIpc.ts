// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import Electron from 'electron';
import { cloudRequest } from './cloud/cloudFetch';
import { getIpcMainProxy } from './ipcMain';
import Logging from '@pkg/utils/logging';
const ipcMain = getIpcMainProxy(Logging.background);
const pathFor = (id:string, suffix='') => `/super-admin/support/sessions/${ encodeURIComponent(id) }${ suffix }`;
async function request(method:string, path:string, body?:unknown):Promise<any> {
  const response = await cloudRequest(method, path, { headers:{ accept:'application/json', ...(body === undefined ? {} : {'content-type':'application/json'}) }, body:body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) { const error:any = new Error(payload.message || payload.error || `Sulla Cloud returned ${ response.status }`); error.code = payload.error; error.status = response.status; throw error; }
  return payload;
}
export function initSupportSessionIpc():void {
  ipcMain.handle('support-session:get', (_e:unknown,id:string) => request('GET', pathFor(id)));
  ipcMain.handle('support-session:events', (_e:unknown,id:string) => request('GET', pathFor(id,'/events?limit=100')));
  ipcMain.handle('support-session:end', (_e:unknown,id:string,reason='resolved') => request('POST', pathFor(id,'/end'), { reason }));
  ipcMain.handle('support-session:extend', (_e:unknown,id:string,hours:number) => request('POST', pathFor(id,'/extend'), { hours }));
  ipcMain.handle('support-session:open-nightly-workflow', async() => {
    await Electron.shell.openExternal('https://github.com/merchantprotocol/sulla-desktop/actions/workflows/package.yaml');
    return { opened:true };
  });
}
