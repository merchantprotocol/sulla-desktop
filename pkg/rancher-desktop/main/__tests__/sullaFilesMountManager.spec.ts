/** @jest-environment node */
import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';

const logLines: string[] = [];

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: new Proxy({}, {
    get: () => ({
      log:   (...args: unknown[]) => logLines.push(args.map(String).join(' ')),
      warn:  (...args: unknown[]) => logLines.push(args.map(String).join(' ')),
      error: (...args: unknown[]) => logLines.push(args.map(String).join(' ')),
    }),
  }),
}));

const { SullaFilesMountManager, sullaFilesMountRetryDelay } = await import('../sullaFilesMountManager');
const { prepareSullaFilesGuestAnchor } = await import('@pkg/backend/guestMountInfo');

const BASE = '22 1 0:20 / / rw,relatime shared:1 - tmpfs tmpfs rw';
const ANCHOR = '612 22 0:20 /mnt/sulla-files /mnt/sulla-files rw,relatime shared:300 - tmpfs tmpfs rw';
const ADAPTER = '720 612 0:61 / /mnt/sulla-files rw,nosuid,nodev shared:301 - fuse.sulla-files sulla-files rw,user_id=0';
const FOREIGN_FUSE = '720 22 0:61 / /mnt/sulla-files rw - fuse.sshfs u@h:/x rw';
const TOKEN = { token: 'x'.repeat(64) };
const provider = () => Promise.resolve(TOKEN);

/**
 * A BusyBox Alpine guest: no findmnt, no fusermount3, the mount table in
 * /proc/self/mountinfo, and the adapter container mounting/unmounting FUSE.
 */
function busyboxGuest(lines: string[], options: { catFailures?: number } = {}) {
  const table = [...lines];
  const commands: string[][] = [];
  let catFailures = options.catFailures ?? 0;
  const remove = (line: string) => { if (table.includes(line)) table.splice(table.indexOf(line), 1) };
  const executor: any = {
    backend:     'lima',
    execCommand: (...args: any[]) => {
      if (typeof args[0] === 'object') args.shift();
      commands.push(args);
      const joined = args.join(' ');

      if (args[0] === 'findmnt' || args[0] === 'fusermount3') return Promise.reject(new Error('limactl exited with code 1'));
      if (args[0] === 'cat' && args[1] === '/proc/self/mountinfo') {
        if (catFailures > 0) {
          catFailures--;

          return Promise.reject(new Error('cat: can\'t open \'/proc/self/mountinfo\''));
        }

        return Promise.resolve(`${ table.join('\n') }\n`);
      }
      if (joined === 'mount --bind /mnt/sulla-files /mnt/sulla-files') table.push(ANCHOR);
      if (args[0] === 'umount') remove(ADAPTER);
      if (joined.includes('stop -t 10 sulla_files_fuse')) remove(ADAPTER);
      if (joined.includes('up -d --no-deps --force-recreate sulla_files_fuse')) table.push(ADAPTER);

      return Promise.resolve('');
    },
    spawn: () => {
      const child: any = new EventEmitter();

      child.stdin = { end: () => { Promise.resolve().then(() => child.emit('exit', 0)) } };

      return child;
    },
  };

  return { executor, commands, table, mounts: () => commands.filter(c => c[0] === 'mount').map(c => c.join(' ')) };
}

/** Mirrors LimaBackend.recoverSullaFilesGuestMount: real preparation, then consumer reconcile. */
function recovery(manager: InstanceType<typeof SullaFilesMountManager>, guest: ReturnType<typeof busyboxGuest>) {
  const calls = { attempts: 0, consumersUpdated: 0, active: 0, maxActive: 0 };
  const recover = async() => {
    calls.attempts++;
    calls.active++;
    calls.maxActive = Math.max(calls.maxActive, calls.active);
    try {
      try {
        await prepareSullaFilesGuestAnchor(guest.executor);
        manager.reportGuestPreparation();
      } catch (error) {
        manager.reportGuestPreparation(error instanceof Error ? error.message : String(error));
        throw error;
      }
      calls.consumersUpdated++;
    } finally {
      calls.active--;
    }
  };

  return { calls, recover };
}

beforeEach(() => { logLines.length = 0 });
afterEach(() => { jest.useRealTimers() });

describe('SullaFilesMountManager on a BusyBox guest', () => {
  test('a failed guest preparation is reported with a reason and does not touch the guest without a recovery hook', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE]);

    manager.configureGuest(guest.executor);
    manager.reportGuestPreparation('Refusing to reuse unexpected Files propagation mount (fuse.sshfs x[/])');
    await expect(manager.start(provider)).resolves.toBeUndefined();
    expect(manager.status()).toMatchObject({ state: 'error', ready: false, reason: expect.stringMatching(/Refusing to reuse/) });
    expect(guest.commands).toEqual([]);
    expect(manager.guestMountAvailable()).toBe(false);
    await manager.stop();
  });

  test('a missing anchor is detected through mountinfo and reported as an error', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE]);

    manager.configureGuest(guest.executor);
    manager.reportGuestPreparation();
    await expect(manager.start(provider)).resolves.toBeUndefined();
    expect(manager.status()).toMatchObject({ state: 'error', reason: 'The Files propagation anchor is unavailable' });
    expect(manager.guestMountAvailable()).toBe(false);
    expect(guest.commands.some(command => command[0] === 'findmnt')).toBe(false);
    await manager.stop();
  });

  test('a healthy anchor starts the adapter', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, ANCHOR]);

    manager.configureGuest(guest.executor);
    manager.reportGuestPreparation();
    await manager.start(provider);
    expect(manager.status()).toMatchObject({ state: 'ready', mountPath: '/mnt/sulla-files' });
    expect(manager.guestMountAvailable()).toBe(true);
    await manager.stop();
  });

  test('stop() unmounts a live adapter with umount when fusermount3 is missing', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, ANCHOR, ADAPTER]);

    guest.executor.execCommand = ((original) => (...args: any[]) => {
      // Keep the adapter mounted through `compose stop` to exercise the unmount fallback.
      const command = typeof args[0] === 'object' ? args.slice(1) : args;

      return command.includes('stop') ? Promise.resolve('') : original(...args);
    })(guest.executor.execCommand);
    manager.configureGuest(guest.executor);
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(guest.commands.map(command => command[0])).toEqual(expect.arrayContaining(['fusermount3', 'umount']));
    expect(guest.table).toEqual([BASE, ANCHOR]);
    expect(manager.status().state).toBe('starting');
  });

  test('stop() still refuses an unexpected mount at the Files path', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, FOREIGN_FUSE]);

    manager.configureGuest(guest.executor);
    await expect(manager.stop()).rejects.toThrow(/unexpected mount occupies/);
    expect(guest.commands.some(command => command[0] === 'umount')).toBe(false);
  });
});

describe('SullaFilesMountManager recovery', () => {
  beforeEach(() => { jest.useFakeTimers() });

  test('the retry schedule is 5s, 10s, 20s, 40s, 60s, then every 5 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(sullaFilesMountRetryDelay)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 300_000, 300_000, 300_000]);
  });

  test('a failed preparation retries on the schedule and the 3rd attempt brings the mount and consumers back', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE], { catFailures: 2 });
    const { calls, recover } = recovery(manager, guest);

    manager.configureGuest(guest.executor, recover);
    manager.reportGuestPreparation('cat: can\'t open \'/proc/self/mountinfo\''); // as at compose time
    await manager.start(provider);
    expect(calls.attempts).toBe(1);
    expect(manager.status()).toMatchObject({ state: 'error', reason: expect.stringMatching(/mountinfo/) });

    await jest.advanceTimersByTimeAsync(4_999);
    expect(calls.attempts).toBe(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls.attempts).toBe(2);
    expect(manager.status().state).toBe('error');

    await jest.advanceTimersByTimeAsync(9_999);
    expect(calls.attempts).toBe(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(calls.attempts).toBe(3);
    expect(manager.status()).toMatchObject({ state: 'ready', mountPath: '/mnt/sulla-files' });
    expect(manager.guestMountAvailable()).toBe(true);
    expect(calls.consumersUpdated).toBe(1);
    expect(guest.mounts()).toEqual(['mount --bind /mnt/sulla-files /mnt/sulla-files', 'mount --make-shared /mnt/sulla-files']);
    expect(guest.commands.some(c => c.join(' ').includes('up -d --no-deps --force-recreate sulla_files_fuse'))).toBe(true);
    // One line for the failure (with its next delay), one for the recovery; no repeats.
    expect(logLines.filter(line => line.startsWith('[SullaFiles]'))).toEqual([
      expect.stringMatching(/^\[SullaFiles\] Files guest mount unavailable: .*mountinfo.*; retrying in 5s$/),
      '[SullaFiles] Files guest mount recovered',
    ]);
    // Success resets the schedule; nothing further is pending except health checks.
    await jest.advanceTimersByTimeAsync(30 * 60_000);
    expect(calls.attempts).toBe(3);
    await manager.stop();
  });

  test('a permanent unexpected mount keeps retrying on the slow schedule and is never reused', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, FOREIGN_FUSE]);
    const { calls, recover } = recovery(manager, guest);
    const attemptTimes: number[] = [];
    const start = Date.now();

    manager.configureGuest(guest.executor, async() => { attemptTimes.push(Date.now() - start); await recover() });
    await manager.start(provider);
    await jest.advanceTimersByTimeAsync(5_000 + 10_000 + 20_000 + 40_000 + 60_000 + 300_000 + 300_000);
    expect(attemptTimes).toEqual([0, 5_000, 15_000, 35_000, 75_000, 135_000, 435_000, 735_000]);
    expect(calls.consumersUpdated).toBe(0);
    expect(guest.mounts()).toEqual([]);
    expect(guest.commands.some(c => c.includes('sulla_files_fuse') && c.includes('up'))).toBe(false);
    expect(manager.status()).toMatchObject({ state: 'error', reason: expect.stringMatching(/Refusing to reuse unexpected Files propagation mount \(fuse\.sshfs/) });
    expect(manager.guestMountAvailable()).toBe(false);
    expect(logLines.filter(line => line.includes('retrying in'))).toHaveLength(1);
    // Lock still refuses to treat the foreign mount as ours.
    await expect(manager.stop()).rejects.toThrow(/unexpected mount occupies/);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('lock cancels the pending retry and unlock resumes from the first delay', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE], { catFailures: 1000 });
    const { calls, recover } = recovery(manager, guest);

    manager.configureGuest(guest.executor, recover);
    await manager.start(provider);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(calls.attempts).toBe(2);
    await manager.stop();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60 * 60_000);
    expect(calls.attempts).toBe(2);

    await manager.start(provider);
    expect(calls.attempts).toBe(3);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(calls.attempts).toBe(4);
    await manager.stop();
  });

  test('attempts never overlap and a lock during an in-flight attempt wins', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE]);
    const { calls, recover } = recovery(manager, guest);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve });

    manager.configureGuest(guest.executor, async() => { await gate; await recover() });
    manager.reportGuestPreparation('bind failed');
    const first = manager.start(provider);
    const second = manager.start(provider);
    await jest.advanceTimersByTimeAsync(60_000);
    const stopped = manager.stop();

    release();
    await Promise.all([first, second, stopped]);
    expect(calls.maxActive).toBe(1);
    // The in-flight attempt finished its preparation, then saw the lock and did not
    // start the adapter; the queued attempt stood down.
    expect(calls.attempts).toBe(1);
    expect(manager.status().state).toBe('starting');
    expect(guest.table).toEqual([BASE, ANCHOR]);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an adapter that disappears is noticed and restarted on the retry schedule', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, ANCHOR]);
    const { calls, recover } = recovery(manager, guest);

    manager.configureGuest(guest.executor, recover);
    manager.reportGuestPreparation();
    await manager.start(provider);
    expect(manager.status().state).toBe('ready');

    guest.table.splice(guest.table.indexOf(ADAPTER), 1); // the adapter container died
    await jest.advanceTimersByTimeAsync(60_000);
    expect(manager.status()).toMatchObject({ state: 'error', reason: 'The guest Files adapter mount disappeared' });
    await jest.advanceTimersByTimeAsync(5_000);
    expect(manager.status().state).toBe('ready');
    expect(calls.attempts).toBe(0); // the anchor survived, so no re-preparation was needed
    expect(guest.table).toEqual([BASE, ANCHOR, ADAPTER]);
    await manager.stop();
  });
});
