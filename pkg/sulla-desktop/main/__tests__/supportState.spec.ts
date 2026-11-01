// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SupportStateStore } from '../supportState';

describe('SupportStateStore', () => {
  let directory: string;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-support-')) });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  test('starts vault-independently and persists state atomically', () => {
    const store = new SupportStateStore(directory);
    expect(store.read().remote.status).toBe('idle');
    store.update(state => { state.remote = { status: 'waiting', requestedAt: 'now' }; state.logging.sources.ai = false });
    const state = new SupportStateStore(directory).read();
    expect(state.remote).toEqual({ status: 'waiting', requestedAt: 'now' });
    expect(state.logging.sources.ai).toBe(false);
    expect(fs.statSync(store.filePath).mode & 0o777).toBe(0o600);
  });
  test('an error enables every source for 24 hours and survives malformed prior data', () => {
    const store = new SupportStateStore(directory);
    fs.writeFileSync(store.filePath, '{bad');
    const now = new Date('2026-11-01T12:00:00.000Z');
    const state = store.noteError(now);
    expect(Object.values(state.logging.sources).every(Boolean)).toBe(true);
    expect(state.logging.lastErrorAt).toBe(now.toISOString());
    expect(state.logging.autoEnabledUntil).toBe('2026-11-02T12:00:00.000Z');
  });
  test('an authenticated offer requires a waiting request and never grants access', () => {
    const store = new SupportStateStore(directory);
    expect(store.noteRemoteOffer('Jonathon', new Date('2026-11-01T12:00:00.000Z')).remote.status).toBe('idle');
    store.update(state => { state.remote = { status: 'waiting', requestedAt: 'now' } });
    expect(store.noteRemoteOffer('Jonathon', new Date('2026-11-01T12:00:00.000Z')).remote).toEqual({
      status: 'approval', requestedAt: 'now', offeredAt: '2026-11-01T12:00:00.000Z', offeredBy: 'Jonathon',
    });
  });
});
