// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ContainerFailureSettlement,
  PreCreateFailureSettlement,
  type FailureWithSecondaryErrors,
} from '@pkg/agent/services/ContainerFailureSettlement';

class RecordingDiagnosticLogger {
  readonly entries: Array<{ message: string; error: unknown }> = [];
  error(message: string, error: unknown): void { this.entries.push({ message, error }) }
}

class SecretDirectoryHarness {
  readonly events: string[] = [];
  private constructor(readonly directory: string) {}

  static async create(): Promise<SecretDirectoryHarness> {
    const directory = await mkdtemp(path.join(tmpdir(), 'container-failure-secrets-'));
    await writeFile(path.join(directory, 'SULLA_API_TOKEN'), 'synthetic-test-credential', { mode: 0o600 });
    return new SecretDirectoryHarness(directory);
  }

  cleaner(): { clean(): Promise<void> } {
    return { clean: async() => { this.events.push('clean'); await rm(this.directory, { recursive: true }) } };
  }

  failingRetainer(error: Error): { retain(): Promise<never> } {
    return { retain: async() => {
      this.events.push('retain');
      await expect(access(this.directory)).rejects.toThrow();
      throw error;
    } };
  }
}

const failurePaths = [
  'persistent lifecycle exit',
  'persistent lifecycle startup',
  'agent process exit',
  'agent job startup',
] as const;

describe('ContainerFailureSettlement', () => {
  it.each(failurePaths)('cleans credentials before a failing keep and preserves the original error: %s', async(context) => {
    // risk: credentials remain mounted and a secondary diagnostics failure hides the real start error
    const harness = await SecretDirectoryHarness.create();
    const original = new Error(`original start error: ${ context }`);
    const keepError = new Error(`keep failed: ${ context }`);
    const logger = new RecordingDiagnosticLogger();
    const settlement = new ContainerFailureSettlement(
      harness.cleaner(), harness.failingRetainer(keepError), logger, context,
    );

    const surfaced = await settlement.settle(original).then(() => { throw original }).catch(error => error);

    expect(harness.events).toEqual(['clean', 'retain']);
    await expect(access(harness.directory)).rejects.toThrow();
    expect(surfaced).toBe(original);
    expect((surfaced as FailureWithSecondaryErrors).secondaryErrors).toEqual([keepError]);
    expect(logger.entries).toEqual([{ message: `${ context }: failed-container retention failed`, error: keepError }]);
  });

  it('records cleanup and retention failures without replacing the original launch error', async() => {
    // risk: cleanup/diagnostic failures obscure the actionable start failure
    const original = new Error('real start failure');
    const cleanupError = new Error('secret cleanup failed');
    const keepError = new Error('keep failed');
    const logger = new RecordingDiagnosticLogger();
    const settlement = new ContainerFailureSettlement(
      { clean: () => Promise.reject(cleanupError) },
      { retain: () => Promise.reject(keepError) },
      logger,
      'startup',
    );

    await settlement.settle(original);

    expect((original as FailureWithSecondaryErrors).secondaryErrors).toEqual([cleanupError, keepError]);
    expect(logger.entries.map(entry => entry.error)).toEqual([cleanupError, keepError]);
  });
});

describe('PreCreateFailureSettlement', () => {
  it.each([
    ['secret cleanup', new Error('secret cleanup failed')],
    ['provider cleanup', new Error('provider cleanup failed')],
  ])('surfaces the original startup error and records %s failure before create', async(_kind, cleanupError) => {
    // risk: a secondary credential cleanup failure masks the actionable launch failure
    const original = new Error('docker create failed');
    const logger = new RecordingDiagnosticLogger();
    const settlement = new PreCreateFailureSettlement(logger);

    await settlement.settle(original, 'before create', () => Promise.reject(cleanupError));

    expect((original as FailureWithSecondaryErrors).secondaryErrors).toEqual([cleanupError]);
    expect(logger.entries).toEqual([{ message: 'before create: credential cleanup failed', error: cleanupError }]);
    expect(original.message).toBe('docker create failed');
  });
});
