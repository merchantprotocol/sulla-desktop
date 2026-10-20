/** @jest-environment node */
import { describe, expect, jest, test } from '@jest/globals';

jest.unstable_mockModule('@pkg/utils/logging', () => ({
  default: new Proxy({}, { get: () => ({ log: () => undefined, warn: () => undefined, error: () => undefined }) }),
}));

const { SullaFilesMountManager } = await import('../sullaFilesMountManager');

const BASE = '22 1 0:20 / / rw,relatime shared:1 - tmpfs tmpfs rw';
const ANCHOR = '612 22 254:17 /sulla-files /mnt/sulla-files rw,relatime shared:300 - ext4 /dev/vdb1 rw';
const ADAPTER = '720 612 0:61 / /mnt/sulla-files rw,nosuid,nodev shared:301 - fuse.sulla-files sulla-files rw,user_id=0';

/** A BusyBox Alpine guest: no findmnt, no fusermount3, mount table in /proc/self/mountinfo. */
function busyboxGuest(lines: string[]) {
  const table = [...lines];
  const commands: string[][] = [];
  const executor: any = {
    backend:     'lima',
    execCommand: (...args: any[]) => {
      if (typeof args[0] === 'object') args.shift();
      commands.push(args);
      if (args[0] === 'findmnt' || args[0] === 'fusermount3') return Promise.reject(new Error('limactl exited with code 1'));
      if (args[0] === 'cat' && args[1] === '/proc/self/mountinfo') return Promise.resolve(`${ table.join('\n') }\n`);
      if (args[0] === 'umount' && table.includes(ADAPTER)) table.splice(table.indexOf(ADAPTER), 1);

      return Promise.resolve('');
    },
  };

  return { executor, commands, table };
}

describe('SullaFilesMountManager on a BusyBox guest', () => {
  test('a failed guest preparation is reported and start() does not touch the guest', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE]);

    manager.configureGuest(guest.executor);
    manager.reportGuestPreparation('Refusing to reuse unexpected Files propagation mount (fuse.sshfs x[/])');
    await expect(manager.start(() => Promise.resolve({ token: 'x'.repeat(64) }))).resolves.toBeUndefined();
    expect(manager.status()).toMatchObject({ state: 'error', ready: false, reason: expect.stringMatching(/Refusing to reuse/) });
    expect(guest.commands).toEqual([]);
  });

  test('a missing anchor is detected through mountinfo and reported as an error', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE]);

    manager.configureGuest(guest.executor);
    await expect(manager.start(() => Promise.resolve({ token: 'x'.repeat(64) }))).rejects.toThrow(/propagation anchor is unavailable/);
    expect(manager.status()).toMatchObject({ state: 'error' });
    expect(guest.commands.some(command => command[0] === 'findmnt')).toBe(false);
  });

  test('stop() unmounts a live adapter with umount when fusermount3 is missing', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, ANCHOR, ADAPTER]);

    manager.configureGuest(guest.executor);
    await expect(manager.stop()).resolves.toBeUndefined();
    expect(guest.commands.map(command => command[0])).toEqual(expect.arrayContaining(['fusermount3', 'umount']));
    expect(guest.table).toEqual([BASE, ANCHOR]);
    expect(manager.status().state).toBe('starting');
  });

  test('stop() still refuses an unexpected mount at the Files path', async() => {
    const manager = new SullaFilesMountManager();
    const guest = busyboxGuest([BASE, '720 22 0:61 / /mnt/sulla-files rw - fuse.sshfs u@h:/x rw']);

    manager.configureGuest(guest.executor);
    await expect(manager.stop()).rejects.toThrow(/unexpected mount occupies/);
    expect(guest.commands.some(command => command[0] === 'umount')).toBe(false);
  });
});
