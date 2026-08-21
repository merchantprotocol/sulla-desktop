import { buildObserverTranscriptMessage } from '../../utils/observerTranscript';
import { CONVERSATION_WRITER_TOOLS } from '../../utils/conversationWriterPolicy';

describe('Conversation Writer observer lockdown', () => {
  it('flattens native tool blocks into plain text instead of replaying them', () => {
    const message = buildObserverTranscriptMessage([
      { role: 'user', content: 'Index the Sulla decision.' },
      { role: 'assistant', content: [
        { type: 'text', text: 'I will inspect it.' },
        { type: 'tool_use', name: 'exec', input: { command: 'cat secrets' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', content: 'secret output' }] },
    ], 'Index salient terms only.');

    expect(message).toContain('[called tool exec');
    expect(message).toContain('[tool result] secret output');
    expect(message).not.toContain('"type":"tool_use"');
    expect(message).toContain('You are a silent OBSERVER');
    expect(message).toContain('Index salient terms only.');
  });

  it('structurally allows only the keyword database writer', () => {
    expect(CONVERSATION_WRITER_TOOLS).toEqual(['upsert_conversation_keywords']);
    expect(CONVERSATION_WRITER_TOOLS).not.toContain('exec');
    expect(CONVERSATION_WRITER_TOOLS).not.toContain('file_search');
    expect(CONVERSATION_WRITER_TOOLS).not.toContain('browser_open');
  });
});
