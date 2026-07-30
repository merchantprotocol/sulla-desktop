import { describe, expect, it } from '@jest/globals';

import { stripProtocolTags, stripProtocolTagsStreaming } from '../stripProtocolTags';

describe('stripProtocolTags', () => {
  it('strips a trailing AGENT_DONE wrapper, leaving only user content (issue #96)', () => {
    const dirty = 'Here is your answer.\n\n<AGENT_DONE>\n<KEY_RESULT>did the thing</KEY_RESULT>\n</AGENT_DONE>';

    expect(stripProtocolTags(dirty)).toBe('Here is your answer.');
  });

  it('strips AGENT_BLOCKED and AGENT_CONTINUE wrappers', () => {
    expect(stripProtocolTags('msg <AGENT_BLOCKED><BLOCKER_REASON>x</BLOCKER_REASON></AGENT_BLOCKED>')).toBe('msg');
    expect(stripProtocolTags('msg <AGENT_CONTINUE>keep going</AGENT_CONTINUE>')).toBe('msg');
  });

  it('removes standalone inner tags if they leak without their wrapper', () => {
    expect(stripProtocolTags('answer <KEY_RESULT>')).toBe('answer');
    expect(stripProtocolTags('answer </STATUS_MESSAGE>')).toBe('answer');
  });

  it('returns empty string when the content is entirely protocol wrappers', () => {
    expect(stripProtocolTags('<AGENT_DONE><KEY_RESULT>internal only</KEY_RESULT></AGENT_DONE>')).toBe('');
  });

  it('leaves clean text untouched', () => {
    expect(stripProtocolTags('just a normal message')).toBe('just a normal message');
  });

  it('handles null/undefined input', () => {
    expect(stripProtocolTags(null)).toBe('');
    expect(stripProtocolTags(undefined)).toBe('');
  });

  it('streaming variant truncates at a half-arrived opening wrapper', () => {
    expect(stripProtocolTagsStreaming('partial answer\n<AGENT_DONE>\nsummary not yet closed')).toBe('partial answer');
  });
});
