// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { FilesCloudIdentityProjection } from './FilesCloudIdentityProjection';
import { ManagedContainerHealthWatcher } from './ManagedContainerHealthWatcher';
import { ContainerHealPlanner, UserStoppedContainers } from '../sullaContainerHealth';
import { FileDeviceIdStore } from '../../main/cloud/device/FileDeviceIdStore';

const syntheticId = 'bf49a1c2-7284-45b1-b52d-d680369797e8';

for (const install of ['new', 'settings-only legacy'] as const) {
  // risk: a healthy Files service should stay mounted, but its next managed
  // Compose lifecycle must take the persisted canonical ID.
  test(`Files projects a late-persisted ${ install } ID on its next lifecycle`, async(t) => {
    const dir = mkdtempSync(join(tmpdir(), 'files-identity-test-'));
    t.after(() => rmSync(dir, { recursive: true }));
    const envFile = join(dir, 'files.env');
    let legacyReads = 0;
    const store = FileDeviceIdStore.in(() => dir, {
      read: async() => {
        legacyReads++;

        return install === 'settings-only legacy' ? syntheticId : null;
      },
    });
    const projection = new FilesCloudIdentityProjection(() => store.readExisting(), async contents => {
      writeFileSync(envFile, contents);
    });

    await projection.refresh(true);
    assert.equal(readFileSync(envFile, 'utf8'), 'SULLA_FILES_CLOUD_DEVICE_ID=\n');
    assert.equal(legacyReads, 0);

    const existing = await store.read();
    if (install === 'new') {
      assert.equal(existing, null);
      assert.equal(await store.createIfAbsent(syntheticId), true);
    } else {
      assert.equal(existing, syntheticId);
    }
    assert.equal(readFileSync(envFile, 'utf8'), 'SULLA_FILES_CLOUD_DEVICE_ID=\n');
    assert.equal(await projection.refresh(), true);
    assert.equal(readFileSync(envFile, 'utf8'), `SULLA_FILES_CLOUD_DEVICE_ID=${ syntheticId }\n`);
    assert.equal(await projection.refresh(), false);
    assert.equal(legacyReads, 1);
  });
}


// risk: an in-place restart would retain the exact stale environment being healed.
test('managed Files heal recreates only with drift and keeps restart recovery', async() => {
  const commands: string[][] = [];
  const events: string[] = [];
  let drifted = true;
  const watcher = new ManagedContainerHealthWatcher(
    { execCommand: (async(_options: unknown, ...command: string[]) => {
      commands.push(command);
      events.push('docker');

      return '';
    }) as never },
    new UserStoppedContainers(), async() => undefined, () => false, new ContainerHealPlanner(),
    async() => { events.push('recover'); },
    async(_target, heal, checkpoint) => {
      checkpoint();
      events.push('refresh');
      await heal(drifted);
    },
  );
  const heal = {
    kind: 'restart' as const, service: 'sulla_files', container: 'sulla_files', managedBy: 'compose' as const,
    reason: 'test', attempt: 1, maxAttempts: 4,
  };

  await watcher.runHealAction(heal, ['docker', 'compose']);
  drifted = false;
  await watcher.runHealAction(heal, ['docker', 'compose']);

  assert.deepEqual(commands, [
    ['docker', 'compose', 'up', '-d', '--no-deps', '--force-recreate', 'sulla_files'],
    ['docker', 'restart', '--time', '10', 'sulla_files'],
  ]);
  assert.deepEqual(events, ['refresh', 'docker', 'recover', 'refresh', 'docker', 'recover']);
});
