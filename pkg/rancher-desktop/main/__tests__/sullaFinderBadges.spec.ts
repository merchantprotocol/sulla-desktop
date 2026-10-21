/** @jest-environment node */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test } from '@jest/globals';

import { FINDER_BADGE_MIN_INTERVAL_MS, FinderBadgeSync } from '../sullaFinderBadges';

function fixture() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'finder-badges-'));

  fs.writeFileSync(path.join(folder, 'a.txt'), 'a');
  const writes: [string, string][] = [];
  let clock = 1_000_000;
  const sync = new FinderBadgeSync(folder, async(target, state) => { writes.push([target, state]) }, () => clock);

  return { folder, writes, sync, advance: (ms: number) => { clock += ms } };
}

describe('FinderBadgeSync', () => {
  test('writes only files that exist under the folder, and only when the state changed', async() => {
    const { folder, writes, sync } = fixture();
    const files = [
      { path: 'a.txt', sync_state: 'synced' },
      { path: 'missing.txt', sync_state: 'synced' },
      { path: '../outside.txt', sync_state: 'synced' },
    ];

    expect(await sync.apply(files)).toBe(1);
    expect(writes).toEqual([[path.join(folder, 'a.txt'), 'synced']]);
    expect(await sync.apply(files)).toBe(0);
    expect(await sync.apply([{ path: 'a.txt', sync_state: 'pending' }])).toBe(1);
  });

  test('passes are single-flight and rate limited', () => {
    const { sync, advance } = fixture();

    expect(sync.begin()).toBe(true);
    expect(sync.begin()).toBe(false);
    sync.end();
    expect(sync.begin()).toBe(false);
    advance(FINDER_BADGE_MIN_INTERVAL_MS);
    expect(sync.begin()).toBe(true);
  });
});
