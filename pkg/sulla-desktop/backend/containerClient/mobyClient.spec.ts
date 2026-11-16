// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import path from 'path';

import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

const { spawnFile, spawn } = vi.hoisted(() => ({
  spawnFile: vi.fn(async() => ({ stdout: '', stderr: '' })),
  spawn:     vi.fn(() => ({ pid: 1 })),
}));

vi.mock('electron', () => ({ app: {}, net: {} }));
vi.mock('@pkg/utils/childProcess', () => ({ ErrorCommand: Symbol('command'), spawn, spawnFile }));
vi.mock('@pkg/utils/logging', () => {
  const log = {
    log: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };

  return { default: { moby: log }, Log: class {} };
});
vi.mock('@pkg/utils/paths', () => ({ default: { resources: '/res' } }));
vi.mock('@pkg/utils/resources', () => ({
  executable: vi.fn((name: string) => path.join('/res', process.platform, 'bin', name)),
}));
vi.mock('@pkg/backend/containerClient/registry', () => ({ default: {} }));
vi.mock('@pkg/utils/dockerUtils', () => ({ parseImageReference: vi.fn() }));
vi.mock('@pkg/backend/backend', () => ({}));

import { MobyClient } from './mobyClient';

const ENDPOINT = 'unix:///tmp/sulla-test.sock';
const vm = {} as any;
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform });
}

function lastSpawnFileCall() {
  const [executable, args, options] = spawnFile.mock.calls.at(-1) as unknown as [string, string[], Record<string, any>];

  return { executable, args, options };
}

describe('MobyClient.runClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', realPlatform);
  });

  describe('on macOS (default constructor)', () => {
    beforeEach(() => setPlatform('darwin'));

    // risk: macOS regression — the bundled docker CLI must still be used with args unchanged.
    it('runs the bundled docker under resources/darwin/bin with the args unchanged', async() => {
      const client = new MobyClient(vm, ENDPOINT);

      expect(client.systemExecutable).toBe(false);
      await client.runClient(['ps', '--all'], 'pipe');

      const { executable, args, options } = lastSpawnFileCall();

      expect(executable).toBe(path.join('/res', 'darwin', 'bin', 'docker'));
      expect(args).toEqual(['ps', '--all']);
      expect(options.stdio).toBe('pipe');
      expect(options.env.DOCKER_HOST).toBe(ENDPOINT);
      expect(options.env.PATH.split(path.delimiter)).toContain(path.join('/res', 'darwin', 'bin'));
    });

    // risk: macOS regression — compose stays the bundled CLI plugin, never `docker compose`.
    it('resolves docker-compose from the bundled docker-cli-plugins with no compose prefix', async() => {
      const client = new MobyClient(vm, ENDPOINT);

      await client.runClient(['--project-name', 'sulla', 'up', '-d'], 'pipe', { executable: 'docker-compose', env: { EXTRA: '1' } });

      const { executable, args, options } = lastSpawnFileCall();
      const pathEntries = options.env.PATH.split(path.delimiter);

      expect(executable).toBe(path.join('/res', 'darwin', 'docker-cli-plugins', 'docker-compose'));
      expect(args).toEqual(['--project-name', 'sulla', 'up', '-d']);
      expect(pathEntries).toContain(path.join('/res', 'darwin', 'docker-cli-plugins'));
      expect(options.env.EXTRA).toBe('1');
      expect(options).not.toHaveProperty('executable');
      expect(options).not.toHaveProperty('systemExecutable');
    });

    it('streams through spawn with the same executable and does not leak client-only options', async() => {
      const client = new MobyClient(vm, ENDPOINT);

      client.runClient(['logs', '-f', 'c1'], 'stream', { executable: 'docker' });

      expect(spawn).toHaveBeenCalledTimes(1);
      const [executable, args, options] = spawn.mock.calls[0] as unknown as [string, string[], Record<string, any>];

      expect(executable).toBe(path.resolve(path.join('/res', 'darwin', 'bin'), 'docker'));
      expect(args).toEqual(['logs', '-f', 'c1']);
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(options).not.toHaveProperty('executable');
      expect(options).not.toHaveProperty('systemExecutable');
    });
  });

  describe('on Linux with the system Docker CLI', () => {
    beforeEach(() => setPlatform('linux'));

    it('runs docker-compose as `docker compose ...` from PATH', async() => {
      const client = new MobyClient(vm, ENDPOINT, { systemExecutable: true });

      await client.runClient(['--project-name', 'sulla', 'up', '-d'], 'pipe', { executable: 'docker-compose' });

      const { executable, args, options } = lastSpawnFileCall();

      expect(executable).toBe('docker');
      expect(args).toEqual(['compose', '--project-name', 'sulla', 'up', '-d']);
      expect(options.env.DOCKER_HOST).toBe(ENDPOINT);
      expect(options).not.toHaveProperty('executable');
      expect(options).not.toHaveProperty('systemExecutable');
    });
  });
});
