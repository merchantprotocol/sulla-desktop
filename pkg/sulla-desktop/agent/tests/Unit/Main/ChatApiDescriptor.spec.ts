// SPDX-License-Identifier: GPL-2.0-or-later
import '../../Support/TestHomeEnv';

import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { ChatCompletionsServer } from '@pkg/main/chatCompletionsServer';
import paths from '@pkg/utils/paths';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getVersion: () => 'test', isPackaged: false }, safeStorage: {}, ipcMain: { handle() {}, on() {} }, BrowserWindow: class {} }));
vi.mock('@pkg/agent/services/WebSocketClientService', () => ({
  getWebSocketClientService: () => ({ connect() {}, onMessage: () => () => {} }),
}));
vi.mock('@pkg/agent/services/AgentContainerLauncher', () => ({ reapOrphanAgentContainers: async() => {} }));
vi.mock('@pkg/agent/database/models/SullaSettingsModel', () => ({ SullaSettingsModel: { get: vi.fn(), set: vi.fn() } }));

describe('chat API descriptor at startup', () => {
  const originalHome = paths.appHome;
  let directory: string;
  let descriptor: string;
  let server: ChatCompletionsServer;

  beforeEach(async() => {
    directory = await mkdtemp(path.join(tmpdir(), 'chat-api-descriptor-'));
    paths.appHome = directory;
    descriptor = path.join(directory, 'chat-api-token.json');
    await writeFile(descriptor, JSON.stringify({ token: 'fixture', pid: -1, port: 1111 }), { mode: 0o400 });
    server = new ChatCompletionsServer();
  });

  afterEach(async() => {
    paths.appHome = originalHome;
    await server.stop();
    await chmod(directory, 0o700);
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('starts and replaces a read-only descriptor with a private descriptor for this process', async() => {
    await server.start(0);
    expect(server.getApiToken()).toBe('fixture');
    expect(JSON.parse(await readFile(descriptor, 'utf8'))).toEqual({ token: 'fixture', pid: process.pid, port: 0 });
    expect((await stat(descriptor)).mode & 0o777).toBe(0o600);
  });

  it.each(['missing', 'invalid'] as const)('uses the replacement settings token on restart when the descriptor is %s', async(condition) => {
    await server.start(0);
    await server.stop();
    await rm(descriptor);
    if (condition === 'invalid') await writeFile(descriptor, JSON.stringify({ token: 42 }));
    vi.mocked(SullaSettingsModel.get).mockResolvedValue('replacement');

    await server.start(0);
    expect(server.getApiToken()).toBe('replacement');
    expect(JSON.parse(await readFile(descriptor, 'utf8')).token).toBe('replacement');
    expect(SullaSettingsModel.set).toHaveBeenLastCalledWith('sullaApiToken', 'replacement', 'string');
  });

  // Root bypasses the directory write permission this case exercises.
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('listens with the file token even when its descriptor cannot be refreshed', async() => {
    const warn = vi.spyOn(console, 'warn');
    await chmod(directory, 0o500);
    await server.start(0);
    expect(server.getApiToken()).toBe('fixture');
    expect(JSON.parse(await readFile(descriptor, 'utf8')).pid).toBe(-1);
    expect(warn).toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain('fixture');
  });
});
