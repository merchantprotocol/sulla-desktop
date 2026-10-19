import { replaceLimaMounts } from '../limaMounts';

describe('Lima mount reconciliation', () => {
  test('replaces persisted mount arrays instead of retaining stale host roots', () => {
    const config:any = {
      mounts: [
        { location: '~', writable: true },
        { location: '/Volumes', writable: true },
        { location: '/private/var/folders', writable: true },
      ],
    };

    replaceLimaMounts(config, [{ location: '/tmp/rancher-desktop', writable: true }]);

    expect(config.mounts).toEqual([{ location: '/tmp/rancher-desktop', writable: true }]);
  });
});
