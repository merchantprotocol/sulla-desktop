// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Sample people, orgs, threads and video data from the design mockup must never ship in the app.
// Screens render only from the real org conversations IPC. Each entry is a string the mockup used.
// risk: data accuracy and privacy; sample names or messages would show as real conversations
const DEMO_STRINGS = [
  'Dana', 'Maya', 'Alex Rivera', 'Lee Wong', 'Rob Kim', 'Sam Okafor', 'Priya', 'Devin Park',
  'Northwind', 'Byrdziak Studio', 'Q1 freight', 'carriers.xlsx', 'Q4 pricing', 'Launch: Sulla',
  'Kickoff · Nov 10', 'Watched through the transcript', 'Jonathon', 'mockBar', 'mock-bar', 'qnote',
  'previewMode', 'simulateUpload', 'VIDEOS', 'REPLIES', 'MAXREC', 'SCREENS', 'ALT_THREADS', 'conversationFixtures',
];

// Production files only. The projection spec keeps its own fixture names; this spec lists the banned strings.
const DIRECTORY = fileURLToPath(new URL('.', import.meta.url));
const SCANNED = ['.ts', '.vue', '.css'];

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return productionFiles(path);
    if (entry.name.endsWith('.spec.ts')) return [];
    return SCANNED.includes(extname(entry.name)) ? [path] : [];
  });
}

describe('Conversations screens', () => {
  it('ship no sample people, orgs, threads or video data', () => {
    // risk: privacy; a demo conversation shown next to real org data would look like real messages
    const hits = productionFiles(DIRECTORY).flatMap(path => {
      const contents = readFileSync(path, 'utf8');
      return DEMO_STRINGS.filter(term => contents.includes(term)).map(term => `${path.slice(DIRECTORY.length)}: ${term}`);
    });

    expect(hits).toEqual([]);
  });
});
