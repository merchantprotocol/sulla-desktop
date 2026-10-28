// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { CONVERSATION_READER_TOOLS } from '../../utils/conversationReaderPolicy';

describe('Conversation Reader tool lockdown', () => {
  it('structurally allows only the two read-only search tools', () => {
    expect(CONVERSATION_READER_TOOLS).toEqual([
      'search_conversation_keywords',
      'search_conversation_logs',
    ]);
  });

  it('excludes every write/act tool', () => {
    expect(CONVERSATION_READER_TOOLS).not.toContain('upsert_conversation_keywords');
    expect(CONVERSATION_READER_TOOLS).not.toContain('exec');
    expect(CONVERSATION_READER_TOOLS).not.toContain('exechost');
    expect(CONVERSATION_READER_TOOLS).not.toContain('file_search');
    expect(CONVERSATION_READER_TOOLS).not.toContain('write_file');
    expect(CONVERSATION_READER_TOOLS).not.toContain('browser_open');
    expect(CONVERSATION_READER_TOOLS).not.toContain('add_observational_memory');
  });
});
