// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readConversationLog } from '@pkg/main/agentConversationLog';

class ConversationLogFixture {
  readonly directory: string;
  readonly file: string;

  private constructor(directory: string) {
    this.directory = directory;
    this.file = path.join(directory, 'conversation.jsonl');
  }

  static async create(lines: object[]): Promise<ConversationLogFixture> {
    const fixture = new ConversationLogFixture(await mkdtemp(path.join(os.tmpdir(), 'sulla-conversation-log-')));

    await writeFile(fixture.file, lines.map(line => JSON.stringify(line)).join('\n') + '\n');
    return fixture;
  }

  async append(line: object): Promise<void> {
    await appendFile(this.file, `${ JSON.stringify(line) }\n`);
  }

  async dispose(): Promise<void> {
    await rm(this.directory, { recursive: true, force: true });
  }
}

describe('readConversationLog', () => {
  let fixture: ConversationLogFixture | undefined;

  afterEach(async() => fixture?.dispose());

  it('keeps source offsets stable when the JSONL file grows', async() => {
    // risk: activity accuracy — repeated tail reads need durable identities for each source record.
    fixture = await ConversationLogFixture.create([
      { type: 'message', role: 'user', ts: '1', content: 'first' },
      { type: 'message', role: 'assistant', ts: '2', content: 'second' },
    ]);
    const first = await readConversationLog(fixture.file, fixture.directory);

    await fixture.append({ type: 'message', role: 'assistant', ts: '3', content: 'third' });
    const second = await readConversationLog(fixture.file, fixture.directory);

    expect(first.entries.map(entry => entry.offset)).toEqual(second.entries.slice(0, 2).map(entry => entry.offset));
    expect(second.entries[2]?.offset).toBeGreaterThan(first.entries[1]?.offset ?? -1);
  });
});
