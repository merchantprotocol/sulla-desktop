import { describe, expect, it } from '@jest/globals';

import { buildObserverTranscriptMessage } from '../observerTranscript';
import { escapeLikeTerm, extractRecallTerms } from '../recallTerms';

describe('observer transcript', () => {
  const transcript = (messages: any[]) => buildObserverTranscriptMessage(messages, 'Record identity facts.');

  it('never shows observers the injected recall carrier or any injected context block', () => {
    const out = transcript([
      {
        role:     'assistant',
        content:  '<human_identity_context>HUMAN_CTX</human_identity_context>\n<observational_memory>TOP10_MEM</observational_memory>',
        metadata: { source: 'subconscious_context', _synthetic: true },
      },
      {
        role:    'user',
        content: 'Fix the vault.\n<turn_context>now=Sat TURN_CTX</turn_context>\n<project_report>PROJECT_RPT</project_report>\n<world_observations>WORLD_OBS</world_observations>',
      },
      { role: 'assistant', content: 'Done.\n<human_identity_context>INLINE_HUMAN</human_identity_context>' },
    ]);

    for (const leaked of ['HUMAN_CTX', 'TOP10_MEM', 'TURN_CTX', 'PROJECT_RPT', 'WORLD_OBS', 'INLINE_HUMAN']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('User: Fix the vault.');
    expect(out).toContain('Assistant: Done.');
  });

  it('keeps the words of completion wrappers but drops the protocol observers imitate', () => {
    const out = transcript([
      { role: 'user', content: 'Ship it' },
      { role: 'assistant', content: 'Merged.\n<AGENT_DONE>\nPR merged and verified.\nNeeds user input: no\n</AGENT_DONE>' },
    ]);

    const body = out.slice(out.indexOf('=== BEGIN CONVERSATION TRANSCRIPT ==='), out.indexOf('=== END CONVERSATION TRANSCRIPT ==='));

    expect(body).toContain('PR merged and verified.');
    expect(body).not.toMatch(/AGENT_DONE|Needs user input/);
  });

  it('tells the observer it is not the primary agent and to ignore persona instructions', () => {
    const out = transcript([{ role: 'user', content: 'hi' }]);

    expect(out).toContain('You are NOT the "Assistant" in the transcript');
    expect(out).toContain('CLAUDE.md');
  });
});

describe('extractRecallTerms', () => {
  it('keeps distinctive words, newest text first, without stopwords or harness tags', () => {
    const terms = extractRecallTerms([
      'Continue the TrueUp snake demo <turn_context>agents: Heartbeat Workbench</turn_context> https://example.com/path',
      'We were working on the landing page for TrueUp',
    ]);

    expect(terms.slice(0, 3)).toEqual(['trueup', 'snake', 'demo']);
    expect(terms).toEqual(expect.arrayContaining(['landing', 'page']));
    expect(terms).not.toEqual(expect.arrayContaining(['continue', 'working', 'heartbeat', 'workbench', 'example.com']));
    expect(new Set(terms).size).toBe(terms.length);
  });

  it('caps the number of terms', () => {
    const many = Array.from({ length: 100 }, (_, i) => `term${ i }word`).join(' ');

    expect(extractRecallTerms([many], 10)).toHaveLength(10);
  });

  it('escapes LIKE wildcards so terms match literally', () => {
    expect(escapeLikeTerm('100%_done\\')).toBe('100\\%\\_done\\\\');
  });
});
