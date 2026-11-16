// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '../../../..');
// Components render inside tabs. Global styles (tooltips) attach to the page body, outside any tab.
const DIRS = ['pages', 'components'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : files(full);
    return /\.(vue|css|scss)$/.test(entry.name) ? [full] : [];
  });
}

describe('background tabs stay hidden', () => {
  // risk: a chat tab in the background is visibility:hidden; one element with
  // visibility:visible inside it (the latest reply's Copy/Reply/Retry row) painted
  // over the Integrations page in front of it
  it('nothing in the window forces visibility: visible (use inherit)', () => {
    const offenders = DIRS.flatMap(dir => files(path.join(ROOT, dir)))
      .filter(file => /visibility\s*:\s*visible\b/.test(fs.readFileSync(file, 'utf8')))
      .map(file => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });
});
