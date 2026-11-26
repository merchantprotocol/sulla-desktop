// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { LogFileRotator } from '../../../../utils/LogFileRotator';

describe('LogFileRotator', () => {
  const directories: string[] = [];
  afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }) });

  it('keeps five capped prior runs and discards the oldest file', () => {
    // risk: startup destroys the previous run's only useful diagnostics or leaves unbounded log history
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-log-rotation-'));
    directories.push(directory);
    const current = path.join(directory, 'background.log');
    fs.writeFileSync(current, 'old-current\nkeep-current\n');
    for (let index = 1; index <= 5; index++) fs.writeFileSync(path.join(directory, `background.${ index }.log`), `backup-${ index }\n`);
    fs.writeFileSync(path.join(directory, 'notes.txt'), 'not a log');

    new LogFileRotator(fs, 5, 16).rotateDirectory(directory);

    expect(fs.readFileSync(path.join(directory, 'background.1.log'), 'utf8')).toContain('keep-current');
    expect(fs.statSync(path.join(directory, 'background.1.log')).size).toBeLessThanOrEqual(16);
    expect(fs.readFileSync(path.join(directory, 'background.2.log'), 'utf8')).toBe('backup-1\n');
    expect(fs.readFileSync(path.join(directory, 'background.5.log'), 'utf8')).toBe('backup-4\n');
    expect(fs.existsSync(path.join(directory, 'background.6.log'))).toBe(false);
    expect(fs.readFileSync(path.join(directory, 'notes.txt'), 'utf8')).toBe('not a log');
  });

  it('does not age a topic history when that topic has no active log in the directory', () => {
    // risk: an unused log topic loses a useful previous run just because this startup did not instantiate its logger
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sulla-log-rotation-'));
    directories.push(directory);
    fs.writeFileSync(path.join(directory, 'sulla.1.log'), 'previous run');

    new LogFileRotator(fs, 5, 16).rotateDirectory(directory);

    expect(fs.readFileSync(path.join(directory, 'sulla.1.log'), 'utf8')).toBe('previous run');
    expect(fs.existsSync(path.join(directory, 'sulla.log'))).toBe(false);
  });
});
