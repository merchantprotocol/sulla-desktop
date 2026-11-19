// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

class FakeElement {
  hidden = false;
  textContent = '';
  innerHTML = '';
  className = '';
  listeners = new Map<string, (...args:any[]) => unknown>();
  classes = new Set<string>();
  classList = {
    add: (name:string) => this.classes.add(name),
    remove: (name:string) => this.classes.delete(name),
    contains: (name:string) => this.classes.has(name),
    toggle: (name:string, force?:boolean) => {
      const enabled = force ?? !this.classes.has(name);
      if (enabled) this.classes.add(name); else this.classes.delete(name);
      return enabled;
    },
  };

  addEventListener(name:string, listener:(...args:any[]) => unknown):void { this.listeners.set(name, listener) }
  click():Promise<unknown> | unknown { return this.listeners.get('click')?.({ preventDefault: () => undefined }) }
}

const script = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'afterCapture.js'), 'utf8');
const capture = { path: '/Files/Screenshots/shot.png', relativePath: 'Screenshots/shot.png', name: 'shot.png', size: 12, kind: 'screenshot', fileId: 'file-1' };

function createHarness(preferences:Record<string, unknown>, responses:Record<string, unknown>) {
  const elements = new Map<string, FakeElement>();
  const ipcHandlers = new Map<string, (...args:any[]) => unknown>();
  const ipcInvocations:Array<[string, ...unknown[]]> = [];
  const ipcMessages:Array<[string, ...unknown[]]> = [];
  const ipcRenderer = {
    on: (name:string, listener:(...args:any[]) => unknown) => ipcHandlers.set(name, listener),
    invoke: vi.fn(async(name:string, ...args:unknown[]) => {
      ipcInvocations.push([name, ...args]);
      if (name === 'tray-panel:files-preferences-get') return preferences;
      const response = responses[name];
      if (response instanceof Error) throw response;
      return response;
    }),
    send: (name:string, ...args:unknown[]) => ipcMessages.push([name, ...args]),
  };
  const documentListeners = new Map<string, (...args:any[]) => unknown>();
  const document = {
    body: { scrollHeight: 100 },
    getElementById: (id:string) => {
      if (!elements.has(id)) elements.set(id, new FakeElement());
      return elements.get(id);
    },
    addEventListener: (name:string, listener:(...args:any[]) => unknown) => documentListeners.set(name, listener),
  };
  const window = { requestAnimationFrame: (callback:() => void) => callback(), Image: class { set src(_value:string) {} } };

  runInNewContext(script, { require: () => ({ ipcRenderer }), document, window, setTimeout, clearTimeout, setInterval, clearInterval, URL, encodeURI, Math, Number, String, RegExp });

  return { elements, ipcHandlers, ipcInvocations, ipcMessages };
}

afterEach(() => vi.useRealTimers());

describe('after-capture tray actions', () => {
  // risk: capture sharing — Share online must invoke public Files sharing without a Cloud-copy/residency toggle and close after the active selection flash.
  it('shares online, copies through the main service, flashes the selected action, then closes', async() => {
    vi.useFakeTimers();
    const harness = createHarness({ defaultAction: 'ask', visitorMode: 'view' }, { 'tray-panel:share-capture': { url: 'https://share.example/1', message: 'Link copied' } });
    await harness.ipcHandlers.get('files-after-capture:show')!({}, capture);

    await harness.elements.get('share')!.click();

    expect(harness.ipcInvocations).toContainEqual(['tray-panel:share-capture', capture, { mode: 'view' }]);
    expect(harness.elements.get('share')!.classList.contains('selected')).toBe(true);
    expect(harness.ipcMessages).not.toContainEqual(['files-after-capture:close']);
    await vi.advanceTimersByTimeAsync(450);
    expect(harness.ipcMessages).toContainEqual(['files-after-capture:close']);
  });

  // risk: data exposure — Save to Files must request the validated absolute Files path copy, then close rather than silently dismissing without copying.
  it('copies the Files path before flashing the selected action and closing', async() => {
    vi.useFakeTimers();
    const harness = createHarness({ defaultAction: 'ask' }, { 'tray-panel:copy-capture-path': '/Files/Screenshots/shot.png' });
    await harness.ipcHandlers.get('files-after-capture:show')!({}, capture);

    await harness.elements.get('save')!.click();

    expect(harness.ipcInvocations).toContainEqual(['tray-panel:copy-capture-path', capture]);
    expect(harness.elements.get('save')!.classList.contains('selected')).toBe(true);
    await vi.advanceTimersByTimeAsync(450);
    expect(harness.ipcMessages).toContainEqual(['files-after-capture:close']);
  });
});
