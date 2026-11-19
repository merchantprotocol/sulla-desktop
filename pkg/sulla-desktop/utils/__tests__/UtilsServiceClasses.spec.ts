// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

const electronApp = vi.hoisted(() => ({ getVersion: () => '9.9.9', isPackaged: false }));
vi.mock('electron', () => ({ default: { app: electronApp } }));
vi.mock('@pkg/utils/logging', () => ({ default: new Proxy({}, { get: () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }) }) }));
vi.mock('@pkg/utils/childProcess', () => ({ spawnFile: vi.fn() }));

import { StartupBudget } from '@pkg/utils/awaitWithBudget';
import { GrepSearchService } from '@pkg/utils/grepSearch';
import { PortOwnerLookup } from '@pkg/utils/portOwner';
import { SafeSender } from '@pkg/utils/safeSend';
import { AppVersionService } from '@pkg/utils/version';

describe('AppVersionService', () => {
  // risk: the docs link points at the wrong release
  it('maps release versions to docs versions and everything else to next', () => {
    const service = new AppVersionService({});

    expect(service.parseDocsVersion('v1.9.3')).toBe('1.9');
    expect(service.parseDocsVersion('1.9.0-tech-preview')).toBe('1.9-tech-preview');
    expect(service.parseDocsVersion('1.9.0-123-g1234567')).toBe('next');
    expect(service.parseDocsVersion('garbage')).toBe('next');
  });

  it('prefers the mock version, then production, then git describe', async() => {
    const runFile = vi.fn().mockResolvedValue({ stdout: 'v2.0.0-4-gabc\n' });

    expect(await new AppVersionService({ SULLA_MOCK_VERSION: '7.7.7' }, runFile).getVersion()).toBe('7.7.7');
    electronApp.isPackaged = true;
    expect(await new AppVersionService({}, runFile).getVersion()).toBe('9.9.9');
    electronApp.isPackaged = false;
    expect(runFile).not.toHaveBeenCalled();
    expect(await new AppVersionService({}, runFile).getVersion()).toBe('v2.0.0-4-gabc');
  });

  it('returns ? when git describe fails', async() => {
    const service = new AppVersionService({}, vi.fn().mockRejectedValue(new Error('no git')));

    expect(await service.getVersion()).toBe('?');
  });
});

describe('PortOwnerLookup.parseLsof', () => {
  it('names the listening process or returns empty', () => {
    expect(PortOwnerLookup.parseLsof('p123\ncnode\n')).toBe('node (pid 123)');
    expect(PortOwnerLookup.parseLsof('p123\n')).toBe('unknown (pid 123)');
    expect(PortOwnerLookup.parseLsof('')).toBe('');
  });
});

describe('SafeSender', () => {
  // risk: a gone renderer crashes main, or real IPC errors go silent
  it('drops sends to destroyed or disposed renderers and warns only once on other errors', () => {
    const logger = { warn: vi.fn() };
    const sender = new SafeSender(logger);
    const ok = { isDestroyed: () => false, send: vi.fn() };
    const disposed = { isDestroyed: () => false, send: () => { throw new Error('Render frame was disposed before WebFrameMain could be accessed') } };
    const broken = { isDestroyed: () => false, send: () => { throw new Error('could not clone') } };

    expect(sender.send(ok as any, 'ch', 1)).toBe(true);
    expect(ok.send).toHaveBeenCalledWith('ch', 1);
    expect(sender.send(null, 'ch')).toBe(false);
    expect(sender.send({ isDestroyed: () => true } as any, 'ch')).toBe(false);
    expect(sender.send(disposed as any, 'ch')).toBe(false);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(sender.send(broken as any, 'ch')).toBe(false);
    expect(sender.send(broken as any, 'ch')).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('StartupBudget', () => {
  it('returns the value inside the budget and times out past it', async() => {
    const logger = { warn: vi.fn() };
    const budget = new StartupBudget(logger);

    expect(await budget.await('fast', Promise.resolve(5), 1_000)).toEqual({ timedOut: false, value: 5 });
    expect(await budget.await('slow', new Promise(() => undefined), 5)).toEqual({ timedOut: true });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    await expect(budget.await('fails', Promise.reject(new Error('boom')), 1_000)).rejects.toThrow('boom');
  });
});

describe('GrepSearchService', () => {
  // risk: search returns nothing or the wrong ranking
  it('falls back from exact query to phrases to words and ranks by hits', async() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-search-spec-'));
    const a = path.join(dir, 'alpha', 'a.md');
    const b = path.join(dir, 'beta', 'b.md');
    const hits: Record<string, string[]> = { 'red apple': [a, b], 'apple pie': [b] };
    const runFile = vi.fn((_cmd: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      const pattern = args[args.indexOf('--') + 1];
      const files = hits[pattern] ?? [];

      cb(files.length ? null : new Error('exit 1'), files.join('\n'));
    });

    try {
      const service = new GrepSearchService(runFile as any);
      const result = await service.searchFilesDetailed('red apple pie', [dir, path.join(dir, 'missing')]);

      expect(result.searchedDirs).toEqual([dir]);
      expect(result.attemptedTerms).toEqual(['red apple pie', 'red apple', 'apple pie']);
      expect(result.matches).toEqual([
        { filePath: b, folderName: 'beta' },
        { filePath: a, folderName: 'alpha' },
      ]);
      expect(await service.searchFiles('  ', [dir])).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
