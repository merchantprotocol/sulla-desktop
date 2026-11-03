// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import yazl from 'yazl';

import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { SupportStateStore, type SupportAttachment, type SupportState } from '@pkg/main/supportState';
import { remoteSupportService } from '@pkg/main/supportRemote';
import { registerGuestSupport, supportCloudRequest, supportWhoAmI } from '@pkg/main/support/supportCloud';
import { updateManager } from '@pkg/main/update/UpdateManager';
import paths from '@pkg/utils/paths';
import { createWindow, getWindow, webRoot } from '@pkg/window';

let registered = false;
const allowedSources = new Set(['desktop', 'runtime', 'containers', 'ai']);
const logTopics: Record<string, string[]> = {
  desktop: ['background.log', 'main.log', 'mainmenu.log'],
  runtime: ['lima.log', 'sullaRuntime.log', 'backend.log'],
  containers: ['docker.log', 'kubernetes.log'],
  ai: ['agent.log', 'claude.log', 'codex.log'],
};

function store() { return new SupportStateStore(app.getPath('userData')) }
function authorize(event: IpcMainInvokeEvent) {
  const window = getWindow('support-center');
  if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame ||
      event.senderFrame.url.split(/[?#]/)[0] !== `${ webRoot }/support.html`) {
    throw new Error('Support requests must come from the Support window.');
  }
  return window;
}
function cleanText(input: unknown, max: number) {
  if (typeof input !== 'string') { throw new Error('Text is required.') }
  const value = input.trim();
  if (!value || value.length > max) { throw new Error(`Text must be between 1 and ${ max } characters.`) }
  return value;
}
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const attachmentTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.txt': 'text/plain', '.log': 'text/plain', '.pdf': 'application/pdf', '.zip': 'application/zip' };
function attachments(input: unknown): SupportAttachment[] {
  if (!Array.isArray(input) || input.length > 10) { throw new Error('Choose up to 10 attachments.') }
  return input.map((item) => {
    if (!item || typeof item.path !== 'string' || typeof item.name !== 'string' || typeof item.size !== 'number') { throw new Error('Invalid attachment.') }
    const file = { path: item.path, name: path.basename(item.name).slice(0, 255), size: Math.max(0, item.size) };
    if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${ file.name } is larger than 25 MB.`);
    if (!attachmentTypes[path.extname(file.name).toLowerCase()]) throw new Error(`${ file.name } is not a supported file type.`);
    return file;
  });
}
function id(prefix: string) { return `${ prefix }-${ Date.now().toString(36).toUpperCase() }` }
function readTail(file: string, maxBytes = 96 * 1024) {
  try {
    const stat = fs.statSync(file); const start = Math.max(0, stat.size - maxBytes); const size = stat.size - start;
    const fd = fs.openSync(file, 'r'); const buffer = Buffer.alloc(size);
    try { fs.readSync(fd, buffer, 0, size, start) } finally { fs.closeSync(fd) }
    return buffer.toString('utf8').replace(/(bearer|token|api[_-]?key|password)\s*[:=]\s*\S+/gi, '$1=[redacted]');
  } catch { return '' }
}

async function cloudRequest(pathname: string, init: RequestInit = {}): Promise<any> {
  const response = await supportCloudRequest(init.method || 'GET', `/support${ pathname }`, init);
  const payload = await response.json().catch(() => ({})) as any;
  if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `Support request failed (${ response.status }).`);
  return payload;
}

function remoteAttachment(value: any): SupportAttachment { return { path: '', name: String(value?.file_name || value?.fileName || 'attachment'), size: Number(value?.size_bytes || value?.sizeBytes || 0) } }
function remoteMessage(value: any): any {
  return { id: String(value.id), createdAt: value.created_at || value.createdAt, body: value.message || '', sender: value.sender === 'admin' ? 'support' : 'user', attachments: (value.attachments || []).map(remoteAttachment) };
}
function remoteTicket(value: any): any {
  const replies = Array.isArray(value?.replies) ? value.replies.map(remoteMessage) : [];
  const first = replies[0];
  return { id: String(value.id), createdAt: value.created_at || value.createdAt, subject: value.subject || '', status: value.status || 'open', body: first?.body || value.message || value.last_message || '', attachments: first?.attachments || [], replies: first ? replies.slice(1) : replies };
}
async function uploadAttachments(input: unknown): Promise<any[]> {
  const files = attachments(input);
  return Promise.all(files.map(async(file) => {
    const bytes = await fs.promises.readFile(file.path);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: attachmentTypes[path.extname(file.name).toLowerCase()] }), file.name);
    return (await cloudRequest('/attachments', { method: 'POST', body: form })).attachment;
  }));
}
function redact(value: string): string { return value.replace(/(bearer|token|api[_-]?key|password)\s*[:=]\s*\S+/gi, '$1=[redacted]') }
async function createLogBundle(state: SupportState): Promise<Buffer> {
  const zip = new yazl.ZipFile();
  for (const [source, names] of Object.entries(logTopics)) for (const name of state.logging.sources[source] ? names : []) {
    const text = readTail(path.join(paths.logs, name), 2 * 1024 * 1024); if (text) zip.addBuffer(Buffer.from(redact(text)), `${ source }/${ name }`);
  }
  zip.end(); const chunks: Buffer[] = []; for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk)); return Buffer.concat(chunks);
}


async function uploadLogAttachment(): Promise<any> {
  const bytes = await createLogBundle(store().read());
  if (bytes.length > MAX_ATTACHMENT_BYTES) throw new Error('The selected logs are larger than 25 MB. Turn off sources and try again.');
  const form = new FormData(); form.append('file', new Blob([new Uint8Array(bytes)], { type: 'application/zip' }), 'sulla-support-logs.zip');
  return (await cloudRequest('/attachments', { method: 'POST', body: form })).attachment;
}

function registerHandlers() {
  if (registered) { return } registered = true;
  ipcMain.on('support:open-remote', (event) => {
    const main = getWindow('main-agent') ?? getWindow('main');
    if (event.sender === main?.webContents) openSupportCenter('remote');
  });
  ipcMain.handle('support:state', (event) => { authorize(event); return store().read() });
  ipcMain.handle('support:cloud-status', async(event) => { authorize(event); try { return await supportWhoAmI() } catch { return { enrolled:false,guest:false } } });
  ipcMain.handle('support:register-guest', async(event,email:unknown) => { authorize(event); return registerGuestSupport(cleanText(email,254), require('node:os').hostname(), app.getVersion()) });
  ipcMain.handle('support:update-status', (event) => { authorize(event); return updateManager.getState() });
  ipcMain.handle('support:update-install', async(event) => { authorize(event); await updateManager.installUpdate() });
  ipcMain.handle('support:set-privacy', async(event, key: unknown, enabled: unknown) => {
    authorize(event); if (!['errorReports', 'metricsConsent', 'autoAttachLogs'].includes(String(key)) || typeof enabled !== 'boolean') throw new Error('Invalid privacy setting.');
    if (key === 'metricsConsent') await cloudRequest('/metrics-consent', { method: 'PUT', body: JSON.stringify({ agreed: enabled }) });
    return store().update(value => { (value.privacy as any)[String(key)] = enabled });
  });
  ipcMain.handle('support:unread', async(event) => { authorize(event); return (await cloudRequest('/unread')).count || 0 });
  ipcMain.handle('support:set-source', (event, source: unknown, enabled: unknown) => {
    authorize(event); if (typeof source !== 'string' || !allowedSources.has(source) || typeof enabled !== 'boolean') { throw new Error('Invalid log source.') }
    return store().update(state => { state.logging.sources[source] = enabled });
  });
  ipcMain.handle('support:logs', (event) => {
    authorize(event); const state = store().read();
    return Object.entries(logTopics).flatMap(([source, names]) => state.logging.sources[source] ? names.map(name => ({ source, name, text: readTail(path.join(paths.logs, name)) })).filter(x => x.text) : []);
  });
  ipcMain.handle('support:download-logs', async(event) => {
    const win = authorize(event); const result = await dialog.showSaveDialog(win, { defaultPath: `sulla-support-logs-${ new Date().toISOString().slice(0, 10) }.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] });
    if (result.canceled || !result.filePath) return false; await fs.promises.writeFile(result.filePath, await createLogBundle(store().read()), { mode: 0o600 }); return true;
  });
  ipcMain.handle('support:send-logs', async(event, ticketId: unknown) => {
    authorize(event); const attachment = await uploadLogAttachment();
    if (typeof ticketId === 'string' && ticketId) {
      await cloudRequest(`/tickets/${ encodeURIComponent(ticketId) }/reply`, { method: 'POST', body: JSON.stringify({ message: 'Diagnostic logs attached from Sulla Desktop.', attachments: [attachment] }) });
      return remoteTicket((await cloudRequest(`/tickets/${ encodeURIComponent(ticketId) }`)).ticket);
    }
    const result = await cloudRequest('/tickets', { method: 'POST', body: JSON.stringify({ subject: 'Diagnostic logs from Sulla Desktop', message: 'I am sending these redacted logs to Sulla support.', attachments: [attachment] }) });
    return remoteTicket((await cloudRequest(`/tickets/${ encodeURIComponent(result.ticket.id) }`)).ticket);
  });
  ipcMain.handle('support:choose-files', async(event) => {
    const win = authorize(event); const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'], filters: [{ name: 'Support files', extensions: ['png', 'jpg', 'jpeg', 'webp', 'txt', 'log', 'pdf', 'zip'] }] });
    if (result.canceled) { return [] }
    return attachments(result.filePaths.slice(0, 10).map(file => ({ path: file, name: path.basename(file), size: fs.statSync(file).size })));
  });
  ipcMain.handle('support:attach-paths', (event, input: unknown) => {
    authorize(event);
    if (!Array.isArray(input) || input.length > 10 || input.some(item => typeof item !== 'string' || !path.isAbsolute(item))) throw new Error('Choose up to 10 files.');
    return attachments(input.map((file: string) => {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error(`${ path.basename(file) } is not a file.`);
      return { path: file, name: path.basename(file), size: stat.size };
    }));
  });
  ipcMain.handle('support:add-feedback', async(event, input: any) => {
    authorize(event); const body = cleanText(input?.body, 10_000); const uploaded = await uploadAttachments(input?.attachments); if (store().read().privacy.autoAttachLogs) uploaded.push(await uploadLogAttachment()); await cloudRequest('/feedback', { method: 'POST', body: JSON.stringify({ message: body, attachments: uploaded }) });
    const message = { id: id('FB'), createdAt: new Date().toISOString(), body, attachments: attachments(input?.attachments) };
    return store().update(state => { state.feedback.unshift(message) });
  });
  ipcMain.handle('support:tickets', async(event) => { authorize(event); const result = await cloudRequest('/tickets'); return Promise.all((result.tickets || []).map(async(ticket: any) => remoteTicket((await cloudRequest(`/tickets/${ encodeURIComponent(ticket.id) }`)).ticket))) });
  ipcMain.handle('support:create-ticket', async(event, input: any) => {
    authorize(event); const subject = cleanText(input?.subject, 160); const body = cleanText(input?.body, 10_000); const uploaded = await uploadAttachments(input?.attachments); if (store().read().privacy.autoAttachLogs) uploaded.push(await uploadLogAttachment()); const result = await cloudRequest('/tickets', { method: 'POST', body: JSON.stringify({ subject, message: body, attachments: uploaded }) });
    const ticket = { ...remoteTicket(result.ticket), subject, body, attachments: attachments(input?.attachments) }; return store().update(state => { state.tickets.unshift(ticket) });
  });
  ipcMain.handle('support:reply-ticket', async(event, input: any) => {
    authorize(event); const ticketId = cleanText(input?.ticketId, 80); const body = cleanText(input?.body, 10_000); const uploaded = await uploadAttachments(input?.attachments); if (store().read().privacy.autoAttachLogs) uploaded.push(await uploadLogAttachment()); await cloudRequest(`/tickets/${ encodeURIComponent(ticketId) }/reply`, { method: 'POST', body: JSON.stringify({ message: body, attachments: uploaded }) });
    return remoteTicket((await cloudRequest(`/tickets/${ encodeURIComponent(ticketId) }`)).ticket);
  });
  ipcMain.handle('support:remote', async(event, action: unknown, input?: unknown) => {
    authorize(event);
    if (action === 'request') return remoteSupportService.request(typeof input === 'string' ? input : '');
    if (action === 'approve') return remoteSupportService.approve();
    if (action === 'end') return remoteSupportService.end();
    if (action === 'reset') return store().update(state => { state.remote = { status: 'idle', activity: state.remote.activity } });
    throw new Error('Invalid support action.');
  });
}

export function initSupportCenterIpc() {
  if (ipcMain.listenerCount('support:open') > 0) return;
  ipcMain.on('support:open', (event, section: unknown) => {
    const trusted = ['first-run', 'main-agent'].some(name => event.sender === getWindow(name as any)?.webContents);
    if (trusted) openSupportCenter(typeof section === 'string' ? section : 'home');
  });
}

export function openSupportCenter(section = 'home') {
  registerHandlers();
  const existing = getWindow('support-center');
  const window = createWindow('support-center', `${ webRoot }/support.html#${ encodeURIComponent(section) }`, {
    title: 'Sulla Support', width: 1120, height: 780, minWidth: 860, minHeight: 620,
    backgroundColor: '#f5f7fa', autoHideMenuBar: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, devTools: !app.isPackaged, webSecurity: true },
  });
  if (existing) { window.webContents.send('support:navigate', section) }
  return window;
}


/** Called only after the Cloud relay authenticates a support offer. */
export function recordRemoteSupportOffer(offeredBy: string): SupportState {
  registerHandlers();
  return store().noteRemoteOffer(offeredBy);
}
