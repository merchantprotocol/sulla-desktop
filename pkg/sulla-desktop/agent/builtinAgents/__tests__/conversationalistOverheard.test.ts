// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isOverheardProtocolTurn, stripProtocolTags, stripProtocolTagsStreaming } from '../../utils/stripProtocolTags';
import { getBuiltinAgentSpecs, renderBuiltinAgent } from '../index';

describe('Conversationalist overheard speech rule', () => {
  const spec = getBuiltinAgentSpecs().find(agent => agent.slug === 'conversationalist')!;
  const prompt = renderBuiltinAgent(spec).prompt_content;

  it('tells the voice agent the exact silent response AgentNode and BaseNode parse', () => {
    const shape = /`(<overheard>[^`]*<\/overheard><AGENT_DONE><\/AGENT_DONE>)`/.exec(prompt)?.[1];
    expect(shape).toBe('<overheard>short private note</overheard><AGENT_DONE></AGENT_DONE>');

    // The shape it is told to write is detected as overheard and never spoken.
    expect(isOverheardProtocolTurn(shape)).toBe(true);
    expect(stripProtocolTags(shape)).toBe('');
    expect(stripProtocolTagsStreaming(shape)).toBe('');
  });

  it('keeps the note out of speech and exempts its memory save from delegation', () => {
    expect(prompt).toContain('## Overheard speech');
    expect(prompt).toMatch(/Never put it inside `<speak>`, never say it aloud/);
    expect(prompt).toMatch(/Save it to long-term memory yourself, without a worker/);
    expect(prompt).toMatch(/only exception to handing work to workers/);
  });
});
