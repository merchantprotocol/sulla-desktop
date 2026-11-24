// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';

import {
  MEMORY_CHAR_BUDGET,
  MemoryBudgetLog,
  MemoryBudgetPacker,
  measureInjectedMemoryBlocks,
  type MemoryCandidate,
} from '../../../memory/MemoryBudget';
import { recallV7SubjectMemory } from '../../../memory/V7SubjectMemory';

const candidate = (overrides: Partial<MemoryCandidate> = {}): MemoryCandidate => ({
  page: 'human',
  pageHeader: '## human.md',
  section: 'Always',
  sectionHeader: '### Always',
  keys: [],
  tier: 1,
  order: 0,
  score: 1,
  ts: 1,
  text: '- Human rule.',
  ...overrides,
});

const observationAwareMeasure = (observations: string) => {
  const reserve = measureInjectedMemoryBlocks(observations, '');
  return (brain: string) => measureInjectedMemoryBlocks(observations, brain) - reserve;
};

describe('MemoryBudgetPacker', () => {
  it('keeps the two injected blocks within 40,000 characters under synthetic overload', () => {
    // risk: the prompt exceeds provider limits and rate-limits every follow-up turn
    const observations = 'O'.repeat(5_500);
    const rules = Array.from({ length: 200 }, (_, index) => candidate({
      text: `- **DO** Human rule ${index}.`.padEnd(115, 'r'),
      keys: [`i:human-${index}`],
      order: index,
      entryKey: `i:human-${index}`,
    }));
    const projectEpisodes = Array.from({ length: 5 }, (_, projectIndex) =>
      Array.from({ length: 200 }, (_, episodeIndex) => candidate({
        page: `project:project-${projectIndex}`,
        pageHeader: `## project-${projectIndex}.md — Project ${projectIndex}`,
        section: 'Recent timeline',
        sectionHeader: '### Recent timeline',
        keys: [`e:${projectIndex}-${episodeIndex}`],
        tier: 3,
        order: 1_000 + projectIndex * 200 + episodeIndex,
        ts: episodeIndex,
        score: episodeIndex / 200,
        text: `- [2026-01-01] Episode ${projectIndex}-${episodeIndex}. ${'timeline '.repeat(12)}`,
        entryKey: `e:${projectIndex}-${episodeIndex}`,
        shortenable: true,
      })),
    ).flat();
    const all = [...rules, ...projectEpisodes];
    const packer = new MemoryBudgetPacker(
      MEMORY_CHAR_BUDGET - measureInjectedMemoryBlocks(observations, ''),
      observationAwareMeasure(observations),
    );

    const packed = packer.pack(all);
    expect(measureInjectedMemoryBlocks(observations, packed.text)).toBeLessThanOrEqual(MEMORY_CHAR_BUDGET);
    expect(observations).toHaveLength(5_500);
    expect(packed.stats.sections.human).toBeGreaterThan(22_000);
    expect(packed.stats.dropped).toBeGreaterThan(0);
  });

  it('fills rules for every mentioned project before timeline and keeps newest episodes first', () => {
    // risk: important operating rules disappear while stale history consumes the prompt budget
    const observations = 'O'.repeat(200);
    const measure = observationAwareMeasure(observations);
    const humanAlways = candidate({ text: '- Always rule.', order: 20, priorityOrder: 0, keys: ['i:always'] });
    const humanStanding = candidate({
      section: 'Standing rules', sectionHeader: '### Standing rules', text: '- Standing rule.',
      order: 21, priorityOrder: 1, keys: ['i:standing'], entryKey: 'i:standing',
    });
    const projectRules = ['alpha', 'beta', 'gamma'].map((slug, index) => candidate({
      page: `project:${slug}`, pageHeader: `## project-${slug}.md`,
      section: 'Rules', sectionHeader: '### Rules', text: `- ${slug} rule.`,
      keys: [`i:${slug}`], order: 100 + index, priorityOrder: 2 + index,
      entryKey: `i:${slug}`,
    }));
    const seeded = candidate({
      page: 'sulla', pageHeader: '## sulla.md — how Sulla works',
      section: 'Shipped rules', sectionHeader: '### Shipped rules', text: '- Seeded Sulla rule.',
      keys: ['i:seeded'], order: 10, priorityOrder: 5, entryKey: 'i:seeded',
    });
    const skill = candidate({
      page: 'skills', pageHeader: '## skills.md — habits', section: 'skill-a',
      sectionHeader: '### Skill A\n_Trigger: when relevant_', text: 'A whole skill body.',
      keys: ['s:skill-a@1'], order: 0, priorityOrder: 6, entryKey: 's:skill-a@1',
    });
    const fact = candidate({
      section: 'Known facts', sectionHeader: '### Known facts', text: '- Known fact.',
      tier: 2, order: 22, priorityOrder: 7, keys: ['i:fact'], entryKey: 'i:fact',
    });
    const overview = candidate({
      page: 'project:alpha', pageHeader: '## project-alpha.md', section: '', sectionHeader: '',
      text: 'Project overview.', tier: 2, order: 101, priorityOrder: 8,
      keys: ['o:alpha@2'], entryKey: 'o:alpha@2',
    });
    const timeline = [
      candidate({
        page: 'project:alpha', pageHeader: '## project-alpha.md', section: 'Recent timeline',
        sectionHeader: '### Recent timeline', text: '- [2026-01-01] Old episode.',
        tier: 3, order: 102, ts: 1, keys: ['e:old'], entryKey: 'e:old', shortenable: true,
      }),
      candidate({
        page: 'project:alpha', pageHeader: '## project-alpha.md', section: 'Recent timeline',
        sectionHeader: '### Recent timeline', text: '- [2026-11-23] New episode.',
        tier: 3, order: 103, ts: 2, keys: ['e:new'], entryKey: 'e:new', shortenable: true,
      }),
    ];
    const emptyPage = candidate({
      page: 'empty-page', pageHeader: '## empty.md', section: 'Empty', sectionHeader: '### Empty section',
      text: `This page must stay closed. ${'unused '.repeat(50)}`,
      tier: 3, order: 104, ts: 0, keys: ['e:empty'], entryKey: 'e:empty', shortenable: true,
    });
    const required = [humanAlways, humanStanding, ...projectRules, seeded, skill, fact, overview, timeline[1]];
    const exactRequiredText = new MemoryBudgetPacker(100_000, measure).pack(required).text;
    const cap = measure(exactRequiredText);
    const packed = new MemoryBudgetPacker(cap, measure).pack([
      ...required.slice(0, -1), ...timeline, emptyPage,
    ]);

    for (const rule of [...projectRules, humanAlways, humanStanding, seeded, skill]) expect(packed.text).toContain(rule.text);
    expect(packed.text).toContain(timeline[1].text);
    expect(packed.text).not.toContain(timeline[0].text);
    for (const rule of [humanAlways, humanStanding, ...projectRules, seeded, skill]) {
      expect(packed.text.indexOf(rule.text)).toBeLessThan(packed.text.indexOf(timeline[1].text));
    }
    expect(packed.text).not.toContain('### Unused section');
    expect(packed.text).not.toContain('## empty.md');
    expect(packed.text).not.toContain('### Empty section');
    for (const row of [...required, timeline[0], emptyPage]) {
      const accepted = row.shortenable && row.text.length > 400
        ? MemoryBudgetPacker.shortenTimelineEntry(row.text)
        : row.text;
      if (packed.text.includes(accepted)) expect(packed.text).toContain(accepted);
      else expect(packed.keys).not.toContain(row.keys[0]);
    }
  });

  it('deduplicates repeated and near-identical full entries across pages before shortening', () => {
    // risk: repeated cross-domain memory crowds out unique facts and misleads with duplicated history
    const first = candidate({ text: '- [2026-02-01] The runtime keeps each check-in under one subject.', keys: ['e:one'], entryKey: 'e:one' });
    const duplicate = candidate({
      page: 'project:other', pageHeader: '## project-other.md', section: 'Timeline', sectionHeader: '### Timeline',
      text: '- [2026-02-01] The runtime keeps each check-in under one subject today.', keys: ['e:two'], entryKey: 'e:two', order: 1,
    });
    const sameId = candidate({
      page: 'lessons', pageHeader: '## lessons.md', section: '', sectionHeader: '',
      text: first.text, keys: ['e:one'], entryKey: 'e:one', order: 2,
    });
    const packed = new MemoryBudgetPacker(10_000).pack([first, duplicate, sameId]);

    expect(packed.text.match(/runtime keeps each check-in/gu)).toHaveLength(1);
    expect(packed.stats.deduped).toBe(2);
    expect(packed.keys).toEqual(['e:one']);
  });

  it('shortens a long timeline record at a sentence boundary and retains its date', () => {
    // risk: a single verbose episode crowds out high-priority memory or gets cut mid-word
    const row = candidate({
      tier: 3, shortenable: true, keys: ['e:long'], entryKey: 'e:long',
      text: `- [2026-11-23] First sentence stays intact. ${'longword '.repeat(100)}`,
    });
    const packed = new MemoryBudgetPacker(10_000).pack([row]);

    expect(packed.text.length).toBeLessThanOrEqual(420 + row.pageHeader.length + row.sectionHeader.length + 8);
    expect(packed.text).toContain('[2026-11-23] First sentence stays intact.');
    expect(packed.text).toContain(' …');
    expect(packed.text).not.toMatch(/longwor…/);
    expect(packed.stats.shortened).toBe(1);
  });

  it('omits a skill that does not fit as a whole and continues to the next whole entry', () => {
    // risk: a truncated skill omits constraints and changes agent behavior
    const rule = candidate({ text: '- **DO** Keep the rule.', keys: ['i:rule'], entryKey: 'i:rule', priorityOrder: 0 });
    const largeSkill = candidate({
      page: 'skills', pageHeader: '## skills.md', section: 'large', sectionHeader: '### Large skill',
      text: `Large skill starts. ${'complete-entry '.repeat(80)}`, keys: ['s:large@1'], entryKey: 's:large@1', priorityOrder: 1,
    });
    const smallSkill = candidate({
      page: 'skills', pageHeader: '## skills.md', section: 'small', sectionHeader: '### Small skill',
      text: 'Small skill stays whole.', keys: ['s:small@1'], entryKey: 's:small@1', priorityOrder: 2,
    });
    const measure = (text: string) => measureInjectedMemoryBlocks('', text);
    const cap = measure(new MemoryBudgetPacker(100_000, measure).pack([rule, smallSkill]).text);
    const packed = new MemoryBudgetPacker(cap, measure).pack([rule, largeSkill, smallSkill]);

    expect(packed.text).toContain(rule.text);
    expect(packed.text).toContain(smallSkill.text);
    expect(packed.text).not.toContain(largeSkill.text);
    expect(packed.keys).toEqual(['i:rule', 's:small@1']);
  });

  it('returns only keys of emitted records, including lessons and Came-from origins', () => {
    // risk: marking a dropped memory as sent permanently hides it, or replaying an emitted item duplicates it
    const emitted = [
      candidate({ text: '- **DO** Keep the database transaction atomic.', keys: ['i:rule', 'e:origin'], entryKey: 'i:rule', order: 0 }),
      candidate({ page: 'skills', pageHeader: '## skills.md', section: 'Skill', sectionHeader: '### Skill', text: 'Complete skill body.', keys: ['s:skill@1'], entryKey: 's:skill@1', order: 1 }),
      candidate({ page: 'lessons', pageHeader: '## lessons.md', section: '', sectionHeader: '', tier: 3, text: '- [2026-11-22] A past lesson.', keys: ['e:lesson'], entryKey: 'e:lesson', order: 2 }),
      candidate({ page: 'project:alpha', pageHeader: '## project-alpha.md', section: '', sectionHeader: '', tier: 2, text: 'Project overview.', keys: ['o:alpha@4'], entryKey: 'o:alpha@4', order: 3 }),
    ];
    const dropped = candidate({ tier: 3, ts: 1, text: '- [2020-01-01] Too old to fit.', keys: ['e:dropped'], entryKey: 'e:dropped', order: 4 });
    const measure = (text: string) => measureInjectedMemoryBlocks('', text);
    const desiredText = new MemoryBudgetPacker(100_000, measure).pack(emitted).text;
    const packed = new MemoryBudgetPacker(measure(desiredText), measure).pack([...emitted, dropped]);

    expect(packed.keys).toEqual(['i:rule', 'e:origin', 's:skill@1', 'e:lesson', 'o:alpha@4']);
    expect(packed.keys).not.toContain('e:dropped');
    expect(packed.text).toContain('Complete skill body.');
    expect(packed.text).toContain('- [2026-11-22] A past lesson.');
  });

  it('injects a database-free recall and records only the keys actually emitted', async () => {
    // risk: a dropped memory is marked sent forever, or a displayed origin/lesson is replayed
    const episodes = [
      { id: 'project-episode', ts: 100, conversationId: null, source: 'user', sentiment: 'neutral', text: 'Alpha memory project timeline.', keys: ['project-alpha'] },
      { id: 'lesson-episode', ts: 99, conversationId: null, source: 'user', sentiment: 'neutral', text: 'Alpha memory lesson timeline.', keys: [] },
      ...Array.from({ length: 20 }, (_, index) => ({
        id: `other-${index}`, ts: 98 - index, conversationId: null, source: 'user', sentiment: 'neutral', text: `Alpha memory context ${index}.`, keys: [],
      })),
      { id: 'origin-episode', ts: 1, conversationId: null, source: 'user', sentiment: 'neutral', text: 'Alpha memory source for a rule.', keys: [] },
    ];
    const cache = {
      signature: 'unit',
      subjects: new Map([['project-alpha', { slug: 'project-alpha', kind: 'project', name: 'Alpha', parent: null, aliases: ['Alpha'] }]]),
      episodes,
      items: [{
        id: 'rule-1', kind: 'policy', ptype: 'do', text: 'Keep the result accurate.', why: null,
        scope: ['global'], ts: 1, always_on: true, confirmed: true, supersedes: null, origin: 'human',
      }],
      evidence: new Map([['origin-episode', ['rule-1']]]),
      overviews: new Map(), skills: [], epVectors: new Map(), itemVectors: new Map(),
      skillVectors: new Map(), subjectVectors: new Map(),
    };
    const ledger = {
      clearThread: vi.fn(async () => undefined),
      deleteExpiredBatch: vi.fn(async () => 0),
      activeKeys: vi.fn(async () => new Set<string>()),
      record: vi.fn(async () => undefined),
    };
    const result = await recallV7SubjectMemory(['Alpha memory'], 'thread-1', true, {
      dependencies: {
        load: async () => cache as any,
        embedder: () => ({ embed: () => new Float32Array([1]) }) as any,
        packer: new MemoryBudgetPacker(100_000),
        sentLedger: ledger,
        getPrimaryUserName: async () => 'Jonathon',
      },
    });

    expect(result).not.toBeNull();
    expect(result?.text).toContain('Alpha memory lesson timeline.');
    expect(result?.text).toContain('Came from: [1970-01-01] Alpha memory source for a rule.');
    expect(result?.keys).toContain('e:origin-episode');
    expect(result?.keys).toContain('e:lesson-episode');
    expect(ledger.clearThread).toHaveBeenCalledWith('thread-1');
    expect(ledger.record).toHaveBeenCalledWith('thread-1', result?.keys);
  });

  it('keeps only the newest check-in per identity and drops a sent winner with its older group', () => {
    // risk: stale check-ins reappear across turns and crowd out current task state
    const packer = new MemoryBudgetPacker();
    const checkins = Array.from({ length: 20 }, (_, index) => ({ id: `checkin-${index}`, ts: index, identity: 'epic-1' }));
    const newest = packer.collapseCheckinGroups(checkins, (entry) => entry.identity, new Set());
    const sent = packer.collapseCheckinGroups(checkins, (entry) => entry.identity, new Set(['e:checkin-19']));

    expect(newest.entries.map((entry) => entry.id)).toEqual(['checkin-19']);
    expect(newest.collapsed).toBe(19);
    expect(sent.entries).toEqual([]);
    expect(sent.collapsed).toBe(19);
  });

  it('assigns a multi-subject episode once to the deepest, highest-ranked subject', () => {
    // risk: one check-in is injected repeatedly under several project domains
    const packer = new MemoryBudgetPacker();
    const episode = { id: 'episode-1', keys: ['project-a', 'project-a-feature', 'project-b-feature'] };
    const assigned = packer.assignMostSpecificSubject([episode], [
      { slug: 'project-a', depth: 1, rank: 0 },
      { slug: 'project-a-feature', depth: 2, rank: 1 },
      { slug: 'project-b-feature', depth: 2, rank: 0 },
    ]);

    expect([...assigned.keys()]).toEqual(['project-b-feature']);
    expect(assigned.get('project-b-feature')).toEqual([episode]);
  });

  it('logs one counts-only line with every required size field', () => {
    // risk: memory payloads leak into logs or prompt-size regressions go unnoticed
    const lines: string[] = [];
    const log = new MemoryBudgetLog((line) => lines.push(line));
    const privateText = 'PRIVATE MEMORY TEXT MUST NEVER BE LOGGED';
    log.write({
      threadId: 'thread-1', observations: privateText, brain: privateText,
      stats: { sections: { skills: 1, sulla: 2, human: 3, 'project:alpha': 4, lessons: 5 }, dropped: 6, deduped: 7, shortened: 8, checkinGroupsCollapsed: 9 },
      teamDirectory: 'team', installedSkills: 'skills', subagentDirectory: 'subagents',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[MemoryBudget] thread=thread-1 observations=');
    for (const field of ['skills=', 'sulla=', 'human=', 'project:alpha=', 'lessons=', 'brain=', 'total=', 'cap=40000', 'dropped=6', 'deduped=7', 'shortened=8', 'checkinGroupsCollapsed=9', 'team_directory=', 'installed_skills=', 'subagent_directory=']) {
      expect(lines[0]).toContain(field);
    }
    expect(lines[0]).not.toContain(privateText);
  });
});
