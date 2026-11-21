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
      if (typeof response === 'function') return response();
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

  return { elements, ipcHandlers, ipcInvocations, ipcMessages, documentListeners };
}

afterEach(() => vi.useRealTimers());

describe('after-capture tray actions', () => {
  // risk: data exposure — a timer or remembered preference must never create a public link or copy a path without a user action.
  it.each(['share', 'save', 'ask'])('does not perform the %s default action when the popup initializes or time passes', async(defaultAction) => {
    vi.useFakeTimers();
    const harness = createHarness({ defaultAction }, {});
    await harness.ipcHandlers.get('files-after-capture:show')!({}, capture);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(harness.ipcInvocations.filter(([name]) => name !== 'tray-panel:files-preferences-get')).toEqual([]);
  });

  // risk: capture sharing — Share online must invoke public Files sharing without a Cloud-copy/residency toggle and close after the active selection flash.
  it('shares online, copies through the main service, flashes the selected action, then closes', async() => {
    vi.useFakeTimers();
    const harness = createHarness({ defaultAction: 'ask', visitorMode: 'view' }, { 'tray-panel:share-popup-capture': { url: 'https://share.example/1', message: 'Link copied' } });
    await harness.ipcHandlers.get('files-after-capture:show')!({}, capture);

    await harness.elements.get('share')!.click();

    expect(harness.ipcInvocations).toContainEqual(['tray-panel:share-popup-capture', { mode: 'view' }]);
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

    expect(harness.ipcInvocations).toContainEqual(['tray-panel:copy-capture-path']);
    expect(harness.elements.get('save')!.classList.contains('selected')).toBe(true);
    await vi.advanceTimersByTimeAsync(450);
    expect(harness.ipcMessages).toContainEqual(['files-after-capture:close']);
  });

  // risk: data loss — cancelling the dialog must not dismiss the only copy of a pending screenshot.
  it('keeps the same popup usable after save cancellation', async() => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce('/chosen/shot.png');
    const harness = createHarness({ defaultAction: 'ask' }, { 'tray-panel:copy-capture-path': save });
    await harness.ipcHandlers.get('files-after-capture:show')!({}, { name: 'shot.png', kind: 'screenshot', size: 12 });

    await harness.elements.get('save')!.click();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.ipcMessages).not.toContainEqual(['files-after-capture:close']);

    await harness.elements.get('save')!.click();
    await vi.advanceTimersByTimeAsync(450);
    expect(save).toHaveBeenCalledTimes(2);
    expect(harness.ipcMessages).toContainEqual(['files-after-capture:close']);
  });

  // risk: data exposure — Enter is an explicit user action and must honor the selected Save to Files action, not publish online.
  it('runs the selected action on explicit Enter', async() => {
    const harness = createHarness({ defaultAction: 'save' }, { 'tray-panel:copy-capture-path': '/Files/Screenshots/shot.png' });
    await harness.ipcHandlers.get('files-after-capture:show')!({}, capture);

    await harness.documentListeners.get('keydown')!({ key: 'Enter' });

    expect(harness.ipcInvocations).toContainEqual(['tray-panel:copy-capture-path']);
    expect(harness.ipcInvocations.some(([name]) => name === 'tray-panel:share-popup-capture')).toBe(false);
  });
});
