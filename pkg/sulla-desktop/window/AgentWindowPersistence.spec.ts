// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { AgentWindowPersistence } from './AgentWindowPersistence';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('AgentWindowPersistence', () => {
  it('round-trips each window record and removes only a closed window while running', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-window-'));
    roots.push(root);
    const file = path.join(root, 'config', 'agent-windows.json');
    const store = new AgentWindowPersistence(file, path.join(root, 'legacy.json'));
    store.update('main', { x: 10, y: 20, width: 800, height: 600 }, false);
    store.update('w_abc', { x: 30, y: 40, width: 900, height: 700 }, true);
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(new AgentWindowPersistence(file, path.join(root, 'legacy.json')).all()).toHaveLength(2);
    store.remove('w_abc');
    expect(new AgentWindowPersistence(file, path.join(root, 'legacy.json')).all()).toEqual([
      { windowKey: 'main', bounds: { x: 10, y: 20, width: 800, height: 600 }, maximized: false },
    ]);
  });

  it('retains records during app quit and migrates legacy main-window bounds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-window-'));
    roots.push(root);
    const file = path.join(root, 'agent-windows.json');
    const legacy = path.join(root, 'main-window-bounds.json');
    fs.writeFileSync(legacy, JSON.stringify({ x: 1, y: 2, width: 900, height: 700, maximized: true }));
    const store = new AgentWindowPersistence(file, legacy);
    expect(store.all()[0]).toMatchObject({ windowKey: 'main', maximized: true });
    store.update('main', { x: 1, y: 2, width: 900, height: 700 }, true);
    await new Promise(resolve => setTimeout(resolve, 400));
    store.setQuitting();
    store.remove('main');
    expect(new AgentWindowPersistence(file, legacy).all()).toHaveLength(1);
  });
});
