// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { app, ipcMain } from 'electron';
import WebSocket from 'ws';

import type { VMBackend } from '@pkg/backend/backend';
import { getServiceLifecycleManager } from '@pkg/agent/services/ServiceLifecycleManager';
import { cloudRequest, isCloudSignedIn } from '@pkg/main/cloud/cloudFetch';
import { signDeviceMessage } from '@pkg/main/cloud/deviceKey';
import { getDesktopDeviceId, getDesktopDeviceMetadata } from '@pkg/main/deviceIdentity';
import { SupportStateStore, type RemoteSupportActivity, type SupportState } from '@pkg/main/supportState';
import { supportUpdateApi } from '@pkg/main/update/UpdateManager';
import Logging from '@pkg/utils/logging';
import paths from '@pkg/utils/paths';
import * as window from '@pkg/window';

const console = Logging.background;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
const POLL_MS = 3_000;
const MAX_ACTIVITY = 500;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const PROVIDER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const AI_PROVIDERS = new Set(['anthropic', 'claude', 'openai', 'codex', 'google', 'gemini', 'xai', 'grok', 'ollama', 'local']);

type Runtime = Pick<VMBackend, 'state' | 'memory' | 'executor'>;
type JsonObject = Record<string, unknown>;
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean };

interface SupportRpcFrame {
  type: 'rpc';
  id: string;
  support?: { eventId: string; sessionId: string; tool: string };
  envelope?: { body?: { method?: string; params?: { name?: string; arguments?: unknown } } };
}

const TOOLS = [
  { name: 'support.logs.tail', description: 'Read redacted Sulla app, runtime, container, or AI logs.', inputSchema: { type: 'object', properties: { source: { enum: ['app', 'runtime', 'containers', 'ai'] }, lines: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['source'], additionalProperties: false }, mutates: false },
  { name: 'support.diagnostics.snapshot', description: 'Read a bounded Sulla runtime diagnostic snapshot.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, mutates: false },
  { name: 'support.containers.list', description: 'List Sulla runtime containers.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, mutates: false },
  { name: 'support.containers.restart', description: 'Restart one Sulla runtime container.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 128 } }, required: ['name'], additionalProperties: false }, mutates: true },
  { name: 'support.containers.logs', description: 'Read redacted logs for one Sulla runtime container.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, lines: { type: 'integer', minimum: 1, maximum: 2000 } }, required: ['name'], additionalProperties: false }, mutates: false },
  { name: 'support.containers.set_memory_limit', description: 'Set a safe memory limit for one Sulla runtime container.', inputSchema: { type: 'object', properties: { name: { type: 'string', minLength: 1, maxLength: 128 }, memoryMiB: { type: 'integer', minimum: 256, maximum: 8192 } }, required: ['name', 'memoryMiB'], additionalProperties: false }, mutates: true },
  { name: 'support.ai.retry_connection', description: 'Retry one named Sulla AI provider service.', inputSchema: { type: 'object', properties: { provider: { type: 'string', minLength: 1, maxLength: 64 } }, required: ['provider'], additionalProperties: false }, mutates: true },
  { name: 'support.update.set_channel', description: 'Select a signed Sulla update channel or pinned signed version.', inputSchema: { type: 'object', properties: { channel: { enum: ['lts', 'nightly'] }, pinnedVersion: { type: ['string', 'null'] } }, required: ['channel'], additionalProperties: false }, mutates: true },
  { name: 'support.update.check_and_install', description: 'Check, download, verify, and install a signed Sulla update.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, mutates: true },
  { name: 'support.update.status', description: 'Read the Sulla update channel and installer status.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, mutates: false },
] as const;

function stateStore() { return new SupportStateStore(app.getPath('userData')) }
function now() { return new Date().toISOString() }
function redacted(value: string): string {
  return value
    .replace(/(bearer|authorization|token|api[_-]?key|password|secret|cookie)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{16,}\b/g, '[redacted]')
    .replace(/\/(?:Users|home)\/[^\s/]+/g, '~');
}
function plainSummary(tool: string): string {
  return ({
    'support.logs.tail': 'Support read redacted Sulla logs',
    'support.diagnostics.snapshot': 'Support checked Sulla diagnostics',
    'support.containers.list': 'Support checked Sulla containers',
    'support.containers.restart': 'Support restarted a Sulla container',
    'support.containers.logs': 'Support read redacted container logs',
    'support.containers.set_memory_limit': 'Support changed a Sulla container memory limit',
    'support.ai.retry_connection': 'Support retried an AI connection',
    'support.update.set_channel': 'Support changed the signed update channel',
    'support.update.check_and_install': 'Support checked and installed a signed update',
    'support.update.status': 'Support checked update status',
  } as Record<string, string>)[tool] || 'Support ran a Sulla support action';
}
function safeInput(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(value as JsonObject)) {
    if (['name', 'source', 'lines', 'memoryMiB', 'provider', 'channel', 'pinnedVersion'].includes(key) && (item === null || ['string', 'number', 'boolean'].includes(typeof item))) result[key] = item;
  }
  return result;
}
function persistActivity(eventId: string, tool: string, input: unknown): RemoteSupportActivity {
  const activity: RemoteSupportActivity = { id: eventId, tool, summary: plainSummary(tool), inputSummary: safeInput(input), status: 'started', startedAt: now() };
  stateStore().update(state => { state.remote.activity = [activity, ...state.remote.activity.filter(item => item.id !== eventId)].slice(0, MAX_ACTIVITY) });
  broadcast();
  return activity;
}
function finishActivity(eventId: string, status: RemoteSupportActivity['status'], started: number) {
  stateStore().update((state) => {
    const item = state.remote.activity.find(entry => entry.id === eventId);
    if (!item) return;
    item.status = status; item.completedAt = now(); item.durationMs = Math.max(0, Date.now() - started);
  });
  broadcast();
}
function broadcast() {
  const state = stateStore().read();
  window.send('support:remote-state' as any, state.remote);
  window.getWindow('support-center')?.webContents.send('support:remote-state', state.remote);
}
async function jsonCloud(method: string, pathname: string, body?: unknown, headers?: Record<string, string>): Promise<any> {
  const response = await cloudRequest(method, pathname, { headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value?.message || value?.error || `Support request failed (${ response.status })`) as Error & { code?: string; status?: number };
    error.code = value?.error; error.status = response.status; throw error;
  }
  return value;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(result) || result < min || result > max) throw new Error(`Expected an integer from ${ min } to ${ max }.`);
  return result;
}
function exactKeys(args: unknown, allowed: string[]): JsonObject {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be an object.');
  const value = args as JsonObject;
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unsupported tool argument.');
  return value;
}
function textResult(value: unknown, isError = false): ToolResult { return { content: [{ type: 'text', text: JSON.stringify(value) }], isError } }

export class RemoteSupportService {
  private runtime?: Runtime;
  private socket?: WebSocket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private poll?: ReturnType<typeof setInterval>;
  private starting = false;
  private reconnectAttempt = 0;

  configureRuntime(runtime: Runtime) { this.runtime = runtime }

  start() {
    if (!this.poll) {
      this.poll = setInterval(() => void this.refreshSession(), POLL_MS);
      this.poll.unref?.();
    }
    void this.restore();
  }

  stop() {
    if (this.reconnect) clearTimeout(this.reconnect);
    if (this.poll) clearInterval(this.poll);
    this.reconnect = undefined; this.poll = undefined; this.reconnectAttempt = 0;
    this.socket?.close(); this.socket = undefined;
  }

  state(): SupportState { return stateStore().read() }

  async request(message: string): Promise<SupportState> {
    const clean = message.trim();
    if (!clean || clean.length > 4000) throw new Error('Describe the problem in 1 to 4,000 characters.');
    const [deviceId, metadata] = await Promise.all([getDesktopDeviceId(), getDesktopDeviceMetadata()]);
    const result = await jsonCloud('POST', '/support/sessions', {
      deviceId, message: clean, appVersion: app.getVersion(), platform: `${ process.platform }-${ process.arch }`,
      deviceName: metadata.name, updateChannel: supportUpdateApi.status().channel, runtimeHealth: this.runtimeHealth(),
    });
    stateStore().update((state) => { state.remote = { status: 'waiting', sessionId: result.session.id, message: clean, requestedAt: result.session.createdAt || now(), activity: [] } });
    broadcast();
    return this.state();
  }

  async approve(): Promise<SupportState> {
    const current = this.state().remote;
    if (current.status !== 'approval' || !current.sessionId) throw new Error('This support request is not ready for approval.');
    const token = crypto.randomBytes(32).toString('base64url');
    const deviceId = await getDesktopDeviceId();
    const signed = signDeviceMessage('support-desktop-v1', [await this.currentUserId(), deviceId, current.sessionId, 'approve', crypto.createHash('sha256').update(token).digest('hex')]);
    const result = await jsonCloud('POST', `/support/sessions/${ encodeURIComponent(current.sessionId) }/approve`, { token, deviceId, ts: signed.ts, signature: signed.signature });
    const expiresAt = result.grant?.expiresAt || result.session?.expiresAt;
    if (typeof expiresAt !== 'string') throw new Error('Cloud did not return a support expiry.');
    stateStore().update((state) => {
      state.remote.status = 'connected'; state.remote.approvedAt = result.session?.approvedAt || now(); state.remote.expiresAt = expiresAt;
      state.remote.grant = { sessionId: current.sessionId!, token, deviceId, expiresAt };
    });
    broadcast();
    await this.ensureHost();
    await this.reportDeviceStatus();
    return this.state();
  }

  async end(reason = 'ended_by_user'): Promise<SupportState> {
    const current = this.state().remote;
    stateStore().clearGrant(reason);
    if (current.sessionId) stateStore().update(state => { state.remote.pendingCloudEnd = { sessionId: current.sessionId!, reason } });
    broadcast();
    this.socket?.close(); this.socket = undefined;
    if (current.sessionId) void this.flushPendingEnd();
    return this.state();
  }

  private async restore() {
    const grant = this.state().remote.grant;
    if (!grant) return;
    if (Date.parse(grant.expiresAt) <= Date.now()) { stateStore().clearGrant('expired'); broadcast(); return }
    try {
      const result = await jsonCloud('GET', `/support/sessions/${ encodeURIComponent(grant.sessionId) }/grant`, undefined, { 'X-Sulla-Support-Token': grant.token });
      if (!result.active) throw new Error('The support grant is no longer active.');
      stateStore().update((state) => { state.remote.status = 'connected'; state.remote.expiresAt = result.expiresAt; state.remote.offeredBy = result.acceptedByName || state.remote.offeredBy; if (state.remote.grant) state.remote.grant.expiresAt = result.expiresAt });
      broadcast(); await this.ensureHost(); await this.reportDeviceStatus();
    } catch (error: any) {
      if (error?.status === 403) { stateStore().clearGrant(error.code === 'support_grant_invalid' ? 'revoked_or_expired' : 'grant_invalid'); broadcast() }
      else this.scheduleReconnect();
    }
  }

  private async refreshSession() {
    if (!await isCloudSignedIn()) return;
    const remote = this.state().remote;
    if (remote.pendingCloudEnd) { await this.flushPendingEnd(); return }
    if (!remote.sessionId || !['waiting', 'approval', 'connected'].includes(remote.status)) return;
    try {
      const { session } = await jsonCloud('GET', `/support/sessions/${ encodeURIComponent(remote.sessionId) }`);
      if (session.status === 'awaiting_user_approval' && remote.status === 'waiting') {
        stateStore().update((state) => { state.remote.status = 'approval'; state.remote.offeredAt = session.acceptedAt; state.remote.offeredBy = session.acceptedByName || session.acceptedBy || 'Sulla support'; state.remote.expiresAt = session.expiresAt });
        broadcast();
      } else if (session.status === 'active' && remote.status === 'connected') {
        stateStore().update((state) => { state.remote.expiresAt = session.expiresAt; if (state.remote.grant) state.remote.grant.expiresAt = session.expiresAt });
        broadcast();
      } else if (session.status === 'ended' || session.status === 'expired') {
        stateStore().clearGrant(session.status); broadcast(); this.socket?.close(); this.socket = undefined;
      }
    } catch (error) { console.debug('[RemoteSupport] session poll failed:', error) }
  }

  private async flushPendingEnd() {
    const pending = this.state().remote.pendingCloudEnd;
    if (!pending) return;
    try {
      await jsonCloud('POST', `/support/sessions/${ encodeURIComponent(pending.sessionId) }/end`, { reason: pending.reason });
      stateStore().update(state => { delete state.remote.pendingCloudEnd });
      broadcast();
    } catch (error) { console.debug('[RemoteSupport] Cloud end is pending until connectivity returns:', error) }
  }

  private async ensureHost() {
    if (this.starting || this.socket?.readyState === WebSocket.OPEN || !this.state().remote.grant) return;
    this.starting = true;
    try {
      const deviceId = await getDesktopDeviceId();
      const grant = this.state().remote.grant!;
      const signed = signDeviceMessage('device-tools-host-v1', [await this.currentUserId(), deviceId, grant.sessionId]);
      const ticket = await jsonCloud('POST', '/device-tools/tickets', { deviceId, role: 'host', sessionId: grant.sessionId, ts: signed.ts, signature: signed.signature });
      await new Promise<void>((resolve, reject) => {
        const socket = new WebSocket(ticket.url);
        const timeout = setTimeout(() => { socket.terminate(); reject(new Error('Support channel connection timed out.')) }, 15_000);
        socket.once('open', () => { clearTimeout(timeout); this.reconnectAttempt = 0; this.socket = socket; this.attachSocket(socket); resolve() });
        socket.once('error', (error) => { clearTimeout(timeout); reject(error) });
      });
    } catch (error) { console.warn('[RemoteSupport] tool host connection failed:', error); this.scheduleReconnect() }
    finally { this.starting = false }
  }

  private async currentUserId(): Promise<string> {
    const { getCurrentUserId } = await import('@pkg/main/sullaCloudAuth');
    const id = await getCurrentUserId();
    if (!id) throw new Error('Sign in to Sulla Cloud to connect support.');
    return id;
  }


  private attachSocket(socket: WebSocket) {
    socket.on('message', data => void this.onSocketFrame(String(data)));
    socket.on('close', () => { if (this.socket === socket) this.socket = undefined; this.scheduleReconnect() });
    socket.on('error', error => console.warn('[RemoteSupport] support tool socket error:', error));
  }

  private scheduleReconnect() {
    if (this.reconnect || !this.state().remote.grant) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** Math.min(this.reconnectAttempt++, 5));
    this.reconnect = setTimeout(() => { this.reconnect = undefined; void this.restore() }, delay);
    this.reconnect.unref?.();
  }

  private async onSocketFrame(raw: string) {
    let frame: any;
    try { frame = JSON.parse(raw) } catch { return }
    if (frame.type === 'support/activity') return;
    if (frame.type !== 'rpc' || typeof frame.id !== 'string') return;
    const rpc = frame as SupportRpcFrame;
    const body = rpc.envelope?.body;
    if (body?.method === 'initialize') { this.reply(frame.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'sulla-desktop-support', version: app.getVersion() } }); return }
    if (body?.method === 'ping') { this.reply(frame.id, {}); return }
    if (body?.method === 'tools/list') { this.reply(frame.id, { tools: TOOLS.map(({ mutates: _mutates, ...tool }) => tool) }); return }
    if (body?.method !== 'tools/call' || !body.params?.name) { this.replyError(frame.id, -32601, 'Method not found'); return }
    const grant = this.state().remote.grant;
    if (!grant || this.state().remote.status !== 'connected' || Date.parse(grant.expiresAt) <= Date.now()) { this.replyError(frame.id, -32003, 'No active local support grant'); return }
    if (!rpc.support || rpc.support.sessionId !== grant.sessionId || rpc.support.tool !== body.params.name) { this.replyError(frame.id, -32003, 'Support authorization metadata does not match the local grant'); return }
    const started = Date.now(); persistActivity(rpc.support.eventId, body.params.name, body.params.arguments);
    try {
      const result = await this.callTool(body.params.name, body.params.arguments);
      finishActivity(rpc.support.eventId, result.isError ? 'tool_error' : 'succeeded', started); this.reply(frame.id, result);
    } catch (error) {
      finishActivity(rpc.support.eventId, 'tool_error', started); this.reply(frame.id, textResult({ error: redacted(error instanceof Error ? error.message : String(error)) }, true));
    }
  }

  private reply(id: string, result: unknown) { this.socket?.send(JSON.stringify({ type: 'rpc_result', id, result })) }
  private replyError(id: string, code: number, message: string) { this.socket?.send(JSON.stringify({ type: 'rpc_result', id, error: { code, message } })) }

  private runtimeRequired(): Runtime {
    if (!this.runtime || !['STARTED', 'DISABLED', 'started', 'disabled'].includes(String(this.runtime.state))) throw new Error('The Sulla runtime is offline.');
    return this.runtime;
  }

  private async vm(...command: string[]): Promise<string> { return this.runtimeRequired().executor.execCommand({ capture: true, expectFailure: true }, ...command) }
  private async sullaContainers(): Promise<Map<string, { image: string; state: string; health: string | null }>> {
    const output = await this.vm('docker', 'ps', '-a', '--filter', 'label=com.docker.compose.project=sulla', '--format', '{{json .}}');
    const result = new Map<string, { image: string; state: string; health: string | null }>();
    for (const line of output.split('\n').filter(Boolean)) {
      try { const row = JSON.parse(line); const name = String(row.Names || row.Name || ''); if (CONTAINER_NAME.test(name)) result.set(name, { image: String(row.Image || ''), state: String(row.State || row.Status || 'unknown').toLowerCase(), health: row.Health ? String(row.Health) : null }) } catch { /* ignore malformed engine rows */ }
    }
    return result;
  }
  private async requireContainer(name: unknown) {
    if (typeof name !== 'string' || !CONTAINER_NAME.test(name)) throw new Error('Invalid Sulla container name.');
    const containers = await this.sullaContainers();
    if (!containers.has(name)) throw new Error('Unknown or non-Sulla container.');
    return { name, containers };
  }

  private async callTool(name: string, raw: unknown): Promise<ToolResult> {
    if (!TOOLS.some(tool => tool.name === name)) throw new Error('Tool is not in the support allowlist.');
    if (name === 'support.logs.tail') {
      const args = exactKeys(raw, ['source', 'lines']); const source = args.source; const lines = integer(args.lines, 200, 1, 2000);
      if (!['app', 'runtime', 'containers', 'ai'].includes(String(source))) throw new Error('Invalid log source.');
      let text = '';
      if (source === 'app') text = this.appLogTail(lines);
      else if (source === 'containers') text = await this.vm('docker', 'compose', '-p', 'sulla', 'logs', '--tail', String(lines), '--no-color');
      else if (source === 'runtime') text = await this.vm('journalctl', '--no-pager', '-n', String(lines), '-u', 'sulla*');
      else text = await this.vm('docker', 'compose', '-p', 'sulla', 'logs', '--tail', String(lines), '--no-color', 'agent');
      const output = redacted(text).split('\n').filter(Boolean).slice(-lines).map(message => ({ at: null, level: null, message: message.slice(0, 4000) }));
      return textResult({ source, lines: output, truncated: output.length >= lines });
    }
    if (name === 'support.diagnostics.snapshot') {
      exactKeys(raw, []); const runtime = this.runtimeRequired();
      const [memoryMiB, meminfo, disk, containers] = await Promise.all([runtime.memory, this.vm('cat', '/proc/meminfo'), this.vm('df', '-B1', '--output=size,avail', '/'), this.sullaContainers()]);
      const available = Number(meminfo.match(/^MemAvailable:\s+(\d+)/m)?.[1] || 0) * 1024;
      const diskRow = disk.trim().split('\n').at(-1)?.trim().split(/\s+/) || [];
      return textResult({ appVersion: app.getVersion(), runtimeVersion: null, os: { platform: 'linux', release: 'runtime-vm', arch: process.arch }, ram: { totalBytes: memoryMiB * 1024 * 1024, availableBytes: available }, disk: { totalBytes: Number(diskRow[0] || 0), availableBytes: Number(diskRow[1] || 0) }, runtime: { status: this.runtimeHealth(), detail: null }, ai: [], recentErrors: [], containers: containers.size });
    }
    if (name === 'support.containers.list') {
      exactKeys(raw, []); const containers = await this.sullaContainers();
      return textResult({ containers: [...containers].map(([containerName, item]) => ({ name: containerName, image: item.image, state: /up|running/.test(item.state) ? 'running' : /restart/.test(item.state) ? 'restarting' : /exit|stop/.test(item.state) ? 'stopped' : 'error', health: item.health, memoryLimitBytes: null })) });
    }
    if (name === 'support.containers.restart') {
      const args = exactKeys(raw, ['name']); const { name: container } = await this.requireContainer(args.name); await this.vm('docker', 'restart', container); const current = await this.sullaContainers();
      return textResult({ name: container, restarted: true, state: current.get(container)?.state || 'unknown' });
    }
    if (name === 'support.containers.logs') {
      const args = exactKeys(raw, ['name', 'lines']); const lines = integer(args.lines, 200, 1, 2000); const { name: container } = await this.requireContainer(args.name);
      const output = redacted(await this.vm('docker', 'logs', '--tail', String(lines), '--timestamps', container)).split('\n').filter(Boolean).slice(-lines).map(message => ({ at: null, message: message.slice(0, 4000) }));
      return textResult({ name: container, lines: output, truncated: output.length >= lines });
    }
    if (name === 'support.containers.set_memory_limit') {
      const args = exactKeys(raw, ['name', 'memoryMiB']); const memoryMiB = integer(args.memoryMiB, 0, 256, 8192); const { name: container } = await this.requireContainer(args.name); const vmMemory = await this.runtimeRequired().memory;
      if (memoryMiB > Math.floor(vmMemory * 0.75)) throw new Error('The limit exceeds 75% of Sulla runtime memory.');
      const previousRaw = await this.vm('docker', 'inspect', '--format', '{{.HostConfig.Memory}}', container); const previousBytes = Number(previousRaw.trim()) || 0;
      await this.vm('docker', 'update', '--memory', `${ memoryMiB }m`, container);
      return textResult({ name: container, previousMemoryMiB: previousBytes ? Math.round(previousBytes / 1048576) : null, memoryMiB, restartRequired: false });
    }
    if (name === 'support.ai.retry_connection') {
      const args = exactKeys(raw, ['provider']); if (typeof args.provider !== 'string' || !PROVIDER.test(args.provider) || !AI_PROVIDERS.has(args.provider.toLowerCase())) throw new Error('Unknown AI provider.');
      const retried = await getServiceLifecycleManager().retryService('model-provider');
      return textResult({ provider: args.provider, status: retried ? 'connected' : 'error', error: retried ? null : 'No retryable Sulla service has that name.' });
    }
    if (name === 'support.update.set_channel') {
      const args = exactKeys(raw, ['channel', 'pinnedVersion']); if (!['lts', 'nightly'].includes(String(args.channel))) throw new Error('Invalid update channel.');
      if (args.pinnedVersion !== undefined && args.pinnedVersion !== null && (typeof args.pinnedVersion !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(args.pinnedVersion))) throw new Error('Invalid pinned semantic version.');
      const previousChannel = supportUpdateApi.status().channel; const state = await supportUpdateApi.setChannel(args.channel as 'lts' | 'nightly', { pinnedVersion: args.pinnedVersion as string | undefined, setBy: 'support' });
      return textResult({ channel: state.channel, pinnedVersion: state.pinnedVersion || null, previousChannel });
    }
    if (name === 'support.update.check_and_install') {
      exactKeys(raw, []); try { const state = await supportUpdateApi.checkAndInstall(); return textResult({ status: state.phase === 'not-available' ? 'up_to_date' : state.phase === 'downloading' ? 'downloading' : state.phase === 'downloaded' ? 'restart_pending' : state.phase === 'error' ? 'error' : 'installing', version: state.availableVersion || null, error: state.error || null }) } catch (error) { return textResult({ status: 'error', version: null, error: redacted(error instanceof Error ? error.message : String(error)) }) }
    }
    if (name === 'support.update.status') {
      exactKeys(raw, []); const status = supportUpdateApi.status(); return textResult({ channel: status.channel, pinnedVersion: status.pinnedVersion || null, currentVersion: status.currentVersion, availableVersion: status.available || null, status: status.downloading === undefined ? 'idle' : 'downloading', lastCheckedAt: null, error: null });
    }
    throw new Error('Tool is not in the support allowlist.');
  }

  private appLogTail(lines: number): string {
    const names = ['background.log', 'main.log', 'agent.log'];
    return names.flatMap((name) => { try { return fs.readFileSync(path.join(paths.logs, name), 'utf8').split('\n').slice(-lines) } catch { return [] } }).slice(-lines).join('\n');
  }

  private runtimeHealth(): 'healthy' | 'degraded' | 'offline' {
    if (!this.runtime) return 'offline';
    return ['STARTED', 'DISABLED', 'started', 'disabled'].includes(String(this.runtime.state)) ? 'healthy' : 'degraded';
  }

  private async reportDeviceStatus() {
    const remote = this.state().remote; if (!remote.sessionId || !remote.grant) return;
    const [metadata, deviceId, userId] = await Promise.all([getDesktopDeviceMetadata(), getDesktopDeviceId(), this.currentUserId()]);
    const signed = signDeviceMessage('support-desktop-v1', [userId, deviceId, remote.sessionId, 'device-status']);
    await jsonCloud('POST', `/support/sessions/${ encodeURIComponent(remote.sessionId) }/device-status`, { deviceId, ts: signed.ts, signature: signed.signature, appVersion: app.getVersion(), updateChannel: supportUpdateApi.status().channel, runtimeHealth: this.runtimeHealth(), deviceName: metadata.name });
  }
}

export const remoteSupportService = new RemoteSupportService();

export function configureRemoteSupportRuntime(runtime: Runtime) { remoteSupportService.configureRuntime(runtime) }
export function startRemoteSupport() {
  ipcMain.handle('support:remote-banner-state', event => {
    const main = window.getWindow('main-agent') ?? window.getWindow('main');
    if (event.sender !== main?.webContents) throw new Error('Support status is only available from the main Sulla window.');
    return remoteSupportService.state().remote;
  });
  ipcMain.handle('support:remote-banner-end', event => {
    const main = window.getWindow('main-agent') ?? window.getWindow('main');
    if (event.sender !== main?.webContents) throw new Error('Support access can only be ended from the main Sulla window.');
    return remoteSupportService.end();
  });
  remoteSupportService.start();
}
