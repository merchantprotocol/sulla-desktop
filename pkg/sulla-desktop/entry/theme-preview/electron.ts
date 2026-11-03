// SPDX-License-Identifier: GPL-2.0-or-later
const listeners = new Map<string, Set<(...args: any[]) => void>>();
const now = new Date();
const history = [{ id:'fixture-chat', type:'chat', title:'Studio theme review', status:'complete', created_at:now.toISOString(), last_active_at:now.toISOString(), pinned:true, archived:false, unread_count:0, message_count:4 }, { id:'fixture-browser', type:'browser', title:'Sulla Desktop documentation', url:'https://sulladesktop.com', status:'complete', created_at:new Date(now.getTime()-86400000).toISOString(), last_active_at:new Date(now.getTime()-86400000).toISOString(), pinned:false, archived:false, unread_count:1, message_count:0 }];
const replies: Record<string, unknown> = {
  'conversation-history:list': history, 'conversation-history:search': history,
  'decisions:list': [], 'decision:list': [], 'sulla-cloud:get-status': { signedIn:true, email:'preview@example.test' },
  'first-run-test-autopilot:get':'', 'first-run-state:get':{},
  'updater:get-state': { phase:'downloaded', currentVersion:'1.7.6', availableVersion:'1.8.0', isPackaged:true, releaseNotes:'## Studio preview\nTheme polish and accessibility improvements.', progress:{ percent:100, bytesPerSecond:0, transferred:100, total:100 } },
};
export const ipcRenderer = {
  invoke: async(channel: string, ..._args: unknown[]) => replies[channel] ?? null,
  send(channel: string, ...args: unknown[]) { listeners.get(channel)?.forEach(fn => fn({}, ...args)); },
  on(channel: string, fn: (...args:any[]) => void) { if (!listeners.has(channel)) listeners.set(channel,new Set()); listeners.get(channel)!.add(fn); return ipcRenderer; },
  once(channel: string, fn: (...args:any[]) => void) { const wrapped=(...args:any[])=>{ ipcRenderer.removeListener(channel,wrapped); fn(...args); }; return ipcRenderer.on(channel,wrapped); },
  off(channel:string, fn:(...args:any[])=>void) { return ipcRenderer.removeListener(channel,fn); },
  removeListener(channel:string, fn:(...args:any[])=>void) { listeners.get(channel)?.delete(fn); return ipcRenderer; },
  removeAllListeners(channel:string) { listeners.delete(channel); return ipcRenderer; },
};
export const shell = { openExternal: async() => undefined };
export const webUtils = { getPathForFile: (file: File) => file.name };
export default { ipcRenderer, shell, webUtils };
