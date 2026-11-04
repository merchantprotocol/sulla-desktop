// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import os from 'os';
import path from 'path';

import paths from '@pkg/utils/paths';

import { BaseTool, ToolResponse } from '../base';
import { runCommand } from '../util/CommandRunner';
import { DesktopSnapshotRegistry } from './DesktopSnapshotRegistry';
import { DesktopTargetPolicy } from './DesktopTargetPolicy';
import { toolRuntime } from '../toolRuntime';

const REF_RE = /^@[a-z0-9]+:e\d+$/;
const SESSION = 'sulla-desktop';

/** Compatibility shim; policy state is owned by DesktopTargetPolicy. */
export function isBlockedDesktopTarget(value: unknown): boolean {
  return new DesktopTargetPolicy().isBlocked(value);
}

function refusal(): ToolResponse {
  return { successBoolean: false, responseString: 'Desktop control refused: this app or window is privacy-protected.' };
}

function binaryPath(): string {
  const bundled = path.join(paths.resources, 'darwin', 'agent-desktop', 'agent-desktop');
  return fs.existsSync(bundled) ? bundled : 'agent-desktop';
}

function flag(args: string[], name: string, value: unknown): void {
  if (typeof value === 'string' && value.length) args.push(name, value);
  else if (typeof value === 'number' && Number.isFinite(value)) args.push(name, String(value));
}

function bool(args: string[], name: string, value: unknown): void { if (value === true) args.push(name); }
function validateText(value: unknown, name: string, required = false): string | undefined {
  if (value == null || value === '') { if (required) throw new Error(`${ name } is required.`); return undefined; }
  if (typeof value !== 'string' || value.length > 10_000 || value.includes('\0')) throw new Error(`${ name } must be a plain string.`);
  return value;
}
function validateRef(value: unknown): string {
  if (typeof value !== 'string' || !REF_RE.test(value)) throw new Error('ref must be a qualified snapshot ref such as @s8f3k2p9:e8.');
  return value;
}
function snapshotId(ref: string): string { return ref.slice(1, ref.indexOf(':')); }
async function audit(tool: string, app: string | undefined, action: string, success: boolean, durationMs: number): Promise<void> {
  try {
    const { postgresClient } = await import('../../database/PostgresClient');
    await postgresClient.query(
      'INSERT INTO desktop_audit (tool, target_app, action, success, duration_ms) VALUES ($1,$2,$3,$4,$5)',
      [tool, app ?? null, action, success, durationMs],
    );
  } catch (error) { console.warn('[desktop audit] insert failed:', error); }
}

async function run(args: string[], timeoutMs = 15_000): Promise<{ response: ToolResponse; parsed?: any }> {
  const result = await runCommand(binaryPath(), ['--session', SESSION, ...args], { timeoutMs, maxOutputChars: 500_000 });
  const raw = result.stdout.trim() || result.stderr.trim();
  if (result.exitCode === 127) return { response: { successBoolean: false, responseString: 'agent-desktop is unavailable. Install it on PATH or restore the bundled binary.' } };
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch { return { response: { successBoolean: false, responseString: raw || `agent-desktop exited ${ result.exitCode }.` } }; }
  return { response: { successBoolean: parsed.ok === true, responseString: JSON.stringify(parsed) }, parsed };
}

export class DesktopWorker extends BaseTool {
  constructor(
    private readonly snapshotRegistry: DesktopSnapshotRegistry = toolRuntime.desktopSnapshotRegistry,
    private readonly targetPolicy: DesktopTargetPolicy = toolRuntime.desktopTargetPolicy,
  ) { super(); }

  private isBlocked(value: unknown): boolean { return this.targetPolicy.isBlocked(value); }

  private rememberSnapshotRefs(parsed: any, app: string, requestedWindowId?: string): void {
    if (!parsed?.ok) return;
    const serialized = JSON.stringify(parsed.data ?? {});
    const ids = new Set<string>();
    if (typeof parsed.data?.snapshot_id === 'string') ids.add(parsed.data.snapshot_id);
    for (const match of serialized.matchAll(/@([a-z0-9]+):e\d+/g)) ids.add(match[1]);
    const windowId = requestedWindowId ?? parsed.data?.window?.id ?? parsed.data?.window?.window_id;
    for (const id of ids) this.snapshotRegistry.remember(id, { app, windowId: typeof windowId === 'string' ? windowId : undefined });
  }

  private async ensureAllowedWindow(app?: string, windowId?: string): Promise<ToolResponse | undefined> {
    if (this.isBlocked(app)) return refusal();
    const args = ['list-windows']; flag(args, '--app', app);
    const result = await run(args);
    if (!result.parsed?.ok) return result.response;
    const windows = Array.isArray(result.parsed?.data?.windows) ? result.parsed.data.windows : Array.isArray(result.parsed?.data) ? result.parsed.data : [];
    const selected = windowId ? windows.filter((item: any) => String(item.id ?? item.window_id) === windowId) : windows;
    if (selected.some((item: any) => this.isBlocked(item.title) || this.isBlocked(item.app ?? item.application))) return refusal();
    return undefined;
  }

  name = '';
  description = '';

  protected async _validatedCall(input: any): Promise<ToolResponse> {
    const app = typeof input.app === 'string' ? input.app : undefined;
    if (this.isBlocked(app)) return refusal();
    if (process.platform !== 'darwin') return { successBoolean: false, responseString: 'Desktop control is only available on macOS' };
    const started = Date.now();
    const tool = this.name;
    let action = tool;
    let response: ToolResponse | undefined;
    let auditedApp = app;
    try {
      const args: string[] = [];
      if (input.headed === true) args.push('--headed');
      switch (tool) {
      case 'permissions':
        args.push('permissions'); bool(args, '--guide', input.guide); action = input.guide ? 'guide' : 'read'; break;
      case 'list_apps':
        args.push('list-apps'); flag(args, '--app', validateText(input.app, 'app')); break;
      case 'list_windows':
        args.push('list-windows'); flag(args, '--app', validateText(input.app, 'app')); break;
      case 'snapshot': { const target = validateText(input.app, 'app', true)!; const denied = await this.ensureAllowedWindow(target, input.window_id); if (denied) { response = denied; break; }
        args.push('snapshot', '--app', target); flag(args, '--window-id', validateText(input.window_id, 'window_id')); if (input.interactive_only !== false) args.push('-i'); bool(args, '--compact', input.compact); bool(args, '--skeleton', input.skeleton); if (input.root) args.push('--root', validateRef(input.root));
        const result = await run(args); response = result.response; this.rememberSnapshotRefs(result.parsed, target, input.window_id); break; }
      case 'find': { const target = validateText(input.app, 'app', true)!; const denied = await this.ensureAllowedWindow(target, input.window_id); if (denied) { response = denied; break; }
        args.push('find', '--app', target); flag(args, '--window-id', validateText(input.window_id, 'window_id')); for (const k of ['role','name','value','text','description','native_id'] as const) flag(args, `--${ k.replace('_','-') }`, validateText(input[k], k)); if (input.root) args.push('--root', validateRef(input.root)); flag(args, '--limit', input.limit); const result = await run(args); response = result.response; this.rememberSnapshotRefs(result.parsed, target, input.window_id); break; }
      case 'get': { const ref = validateRef(input.ref); const owner = this.snapshotRegistry.lookup(snapshotId(ref)); auditedApp = owner?.app; if (!owner || this.isBlocked(owner.app)) { response = refusal(); break; } const denied = await this.ensureAllowedWindow(owner.app, owner.windowId); if (denied) { response = denied; break; }
        args.push('get', ref); flag(args, '--property', validateText(input.property, 'property')); break; }
      case 'act': { const ref = validateRef(input.ref); const owner = this.snapshotRegistry.lookup(snapshotId(ref)); auditedApp = owner?.app; if (!owner || this.isBlocked(owner.app)) { response = refusal(); break; } const denied = await this.ensureAllowedWindow(owner.app, owner.windowId); if (denied) { response = denied; break; }
        const map: Record<string,string> = { double_click:'double-click', right_click:'right-click', set_value:'set-value', scroll_to:'scroll-to' }; const cmd = map[input.action] ?? input.action; if (!['click','double-click','right-click','type','set-value','clear','focus','select','toggle','check','uncheck','expand','collapse','scroll','scroll-to','press'].includes(cmd)) throw new Error('Unsupported desktop action.'); action = cmd;
        if (cmd === 'press') { args.push('press', validateText(input.keys, 'keys', true)!); flag(args, '--app', owner.app); }
        else { args.push(cmd, ref); if (cmd === 'type') args.push(validateText(input.text, 'text', true)!); if (cmd === 'set-value' || cmd === 'select') args.push(validateText(input.value, 'value', true)!); flag(args, '--direction', validateText(input.direction, 'direction')); flag(args, '--amount', input.amount); } break; }
      case 'screenshot': { const target = validateText(input.app, 'app', true)!; const denied = await this.ensureAllowedWindow(target, input.window_id); if (denied) { response = denied; break; }
        const out = validateText(input.path, 'path') ?? path.join(os.tmpdir(), `sulla-desktop-${ Date.now() }.png`); args.push('screenshot', '--app', target); flag(args, '--window-id', validateText(input.window_id, 'window_id')); args.push(out); break; }
      case 'app': { const op = validateText(input.action, 'action', true)!; const commands: Record<string,string> = { launch:'launch', close_app:'close-app', focus_window:'focus-window', resize:'resize-window', move:'move-window', minimize:'minimize', maximize:'maximize', restore:'restore' }; const cmd=commands[op]; if (!cmd) throw new Error('Unsupported app action.'); action=op; const target=validateText(input.app,'app',op==='launch'||op==='close_app'); if (this.isBlocked(target) || this.isBlocked(input.title)) { response=refusal(); break; } args.push(cmd); if (op==='launch'||op==='close_app') args.push(target!); else { flag(args,'--app',target); flag(args,'--window-id',validateText(input.window_id,'window_id')); } if (op==='focus_window') flag(args,'--title',validateText(input.title,'title')); flag(args,'--width',input.width); flag(args,'--height',input.height); flag(args,'--x',input.x); flag(args,'--y',input.y); break; }
      case 'clipboard': { const op=validateText(input.action,'action',true)!; action=op; if (op==='get') args.push('clipboard-get'); else if (op==='set') args.push('clipboard-set',validateText(input.text,'text',true)!); else if (op==='clear') args.push('clipboard-clear'); else throw new Error('Unsupported clipboard action.'); break; }
      case 'wait': args.push('wait'); if (input.ms != null) args.push(String(input.ms)); flag(args,'--element',input.element ? validateRef(input.element):undefined); flag(args,'--window',validateText(input.window,'window')); flag(args,'--text',validateText(input.text,'text')); flag(args,'--app',validateText(input.app,'app')); flag(args,'--timeout',input.timeout); break;
      case 'guide': { const desktop=await run(['skills','get','desktop']); if (!desktop.response.successBoolean) { response=desktop.response; break; } const platform=await run(['skills','get','platform']); response={ successBoolean: platform.response.successBoolean, responseString: `${ desktop.response.responseString }\n\n${ platform.response.responseString }` }; break; }
      default: throw new Error(`Unknown desktop tool: ${ tool }`);
      }
      if (!response) response = (await run(args, tool === 'wait' ? 35_000 : 15_000)).response;
    } catch (error) { response = { successBoolean: false, responseString: (error as Error).message }; }
    await audit(tool, auditedApp, action, response.successBoolean, Date.now() - started);
    return response;
  }
}
