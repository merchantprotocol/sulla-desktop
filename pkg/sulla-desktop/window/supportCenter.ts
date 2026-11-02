// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import path from 'node:path';

import { app, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';

import { SupportStateStore, type SupportAttachment, type SupportState } from '@pkg/main/supportState';
import { CLOUD_API_BASE } from '@pkg/main/cloud/cloudEndpoints';
import { getCurrentAccessToken, isCloudSignedIn } from '@pkg/main/sullaCloudAuth';
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
function attachments(input: unknown): SupportAttachment[] {
  if (!Array.isArray(input) || input.length > 10) { throw new Error('Choose up to 10 attachments.') }
  return input.map((item) => {
    if (!item || typeof item.path !== 'string' || typeof item.name !== 'string' || typeof item.size !== 'number') { throw new Error('Invalid attachment.') }
    return { path: item.path, name: path.basename(item.name).slice(0, 255), size: Math.max(0, item.size) };
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
  const token = await getCurrentAccessToken();
  if (!token) throw new Error('Sign in to Sulla Cloud to use Support Center tickets and feedback.');
  const response = await fetch(`${ CLOUD_API_BASE }/support${ pathname }`, {
    ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ token }`, ...(init.headers || {}) },
    signal: AbortSignal.timeout(20_000),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.error === 'string' ? body.error : `Support request failed (${ response.status }).`);
  return body;
}

function remoteTicket(value: any): any {
  const replies = Array.isArray(value?.replies) ? value.replies : [];
  return { id: String(value.id), createdAt: value.created_at || value.createdAt, subject: value.subject || '', body: value.message || value.last_message || '', attachments: [], replies: replies.map((reply: any) => ({ id: String(reply.id), createdAt: reply.created_at || reply.createdAt, body: reply.message || '', attachments: [] })) };
}

function registerHandlers() {
  if (registered) { return } registered = true;
  ipcMain.handle('support:state', (event) => { authorize(event); return store().read() });
  ipcMain.handle('support:cloud-status', async(event) => { authorize(event); return { signedIn: await isCloudSignedIn() } });
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
  ipcMain.handle('support:choose-files', async(event) => {
    const win = authorize(event); const result = await dialog.showOpenDialog(win, { properties: ['openFile', 'multiSelections'] });
    if (result.canceled) { return [] }
    return result.filePaths.slice(0, 10).map(file => ({ path: file, name: path.basename(file), size: fs.statSync(file).size }));
  });
  ipcMain.handle('support:add-feedback', async(event, input: any) => {
    authorize(event); const body = cleanText(input?.body, 10_000); await cloudRequest('/feedback', { method: 'POST', body: JSON.stringify({ message: body, attachments: [] }) });
    const message = { id: id('FB'), createdAt: new Date().toISOString(), body, attachments: attachments(input?.attachments) };
    return store().update(state => { state.feedback.unshift(message) });
  });
  ipcMain.handle('support:tickets', async(event) => { authorize(event); const result = await cloudRequest('/tickets'); return (result.tickets || []).map(remoteTicket) });
  ipcMain.handle('support:create-ticket', async(event, input: any) => {
    authorize(event); const subject = cleanText(input?.subject, 160); const body = cleanText(input?.body, 10_000); const result = await cloudRequest('/tickets', { method: 'POST', body: JSON.stringify({ subject, message: body, attachments: [] }) });
    const ticket = { ...remoteTicket(result.ticket), subject, body, attachments: attachments(input?.attachments) }; return store().update(state => { state.tickets.unshift(ticket) });
  });
  ipcMain.handle('support:reply-ticket', async(event, input: any) => {
    authorize(event); const ticketId = cleanText(input?.ticketId, 80); const body = cleanText(input?.body, 10_000); await cloudRequest(`/tickets/${ encodeURIComponent(ticketId) }/reply`, { method: 'POST', body: JSON.stringify({ message: body, attachments: [] }) });
    return store().update((state) => { const ticket = state.tickets.find(item => item.id === ticketId); if (ticket) ticket.replies.push({ id: id('REPLY'), createdAt: new Date().toISOString(), body, attachments: [] }); });
  });
  ipcMain.handle('support:remote', (event, action: unknown) => {
    authorize(event); if (!['request', 'approve', 'end', 'reset'].includes(String(action))) { throw new Error('Invalid support action.') }
    return store().update((state) => {
      const now = new Date().toISOString();
      if (action === 'request' && ['idle', 'ended'].includes(state.remote.status)) { state.remote = { status: 'waiting', requestedAt: now } }
      else if (action === 'approve' && state.remote.status === 'approval') { state.remote.status = 'connected'; state.remote.approvedAt = now }
      else if (action === 'end' && state.remote.status !== 'idle') { state.remote.status = 'ended'; state.remote.endedAt = now }
      else if (action === 'reset') { state.remote = { status: 'idle' } }
      else { throw new Error('That support transition is not available.') }
    });
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
