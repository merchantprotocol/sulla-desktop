// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';

import { ConversationToolPayloadStore } from './conversationToolPayloadStore';

// risk: data accuracy — expanding a large Detailed tool row must recover every character from its durable JSONL event.
it('loads the complete 5 MB tool result by thread and tool id, without reading outside the log directory', async() => {
  const directory = await mkdtemp(path.join(tmpdir(), 'sulla-tool-payload-'));
  try {
    const file = path.join(directory, 'conversation.jsonl');
    const result = `RESULT_START:${ 'x'.repeat(5_000_000) }:RESULT_END`;
    await writeFile(file, `${ JSON.stringify({ type: 'tool_call', toolCallId: 'run-1', toolName: 'exec', result }) }\n`);
    const history = { getFileAssociations: vi.fn(async() => ({ log_file: file })) };
    const store = new ConversationToolPayloadStore(history, () => directory);

    const event = await store.load('thread-1', 'run-1') as { result: string; toolCallId: string };
    expect(event).toMatchObject({ toolCallId: 'run-1', result });
    expect(await store.load('thread-1', 'missing')).toBeNull();
    history.getFileAssociations.mockResolvedValue({ log_file: path.join(tmpdir(), 'outside.jsonl') });
    expect(await store.load('thread-1', 'run-1')).toBeNull();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
