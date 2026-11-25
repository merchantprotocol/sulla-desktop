// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export const MEMORY_CHAR_BUDGET = 40_000;
const ENTRY_SOFT_LIMIT = 400;
const ENTRY_SHORT_LIMIT = 420;

/** A whole, independently selectable entry from a recalled memory page. */
export interface MemoryCandidate {
  page: string;
  pageHeader: string;
  section: string;
  sectionHeader: string;
  keys: string[];
  tier: number;
  order: number;
  /** Fill-order override; `order` remains the stable page display order. */
  priorityOrder?: number;
  score: number;
  ts: number;
  text: string;
  /** Identifies one stored row even when the row also carries an origin key. */
  entryKey?: string;
  /** Episodes and lessons may be shortened; skills and policy items may not. */
  shortenable?: boolean;
}

export interface MemoryBudgetStats {
  sections: Record<string, number>;
  dropped: number;
  deduped: number;
  shortened: number;
  checkinGroupsCollapsed: number;
  brainCharacters: number;
  measuredCharacters: number;
}

export interface MemoryBudgetResult {
  text: string;
  keys: string[];
  stats: MemoryBudgetStats;
}

export interface CheckinCollapseResult<T> {
  entries: T[];
  collapsed: number;
}

export interface ChosenMemorySubject {
  slug: string;
  depth: number;
  rank: number;
}

export interface MemoryBudgetLogInput {
  threadId: string;
  brain: string;
  stats?: Partial<MemoryBudgetStats>;
  teamDirectory?: string;
  installedSkills?: string;
  subagentDirectory?: string;
}

/** Measures precisely the brain-memory wrapper BaseNode injects. */
export function measureInjectedMemoryBlocks(brain: string): number {
  const blocks: string[] = [];
  const brainText = brain.trim();
  if (brainText) blocks.push(`<brain_memory>\n${ brainText }\n</brain_memory>`);
  return blocks.join('\n\n').length;
}

/**
 * Packs complete memory entries in priority order while charging the actual
 * page and section headings only when an entry opens them.
 */
export class MemoryBudgetPacker {
  constructor(
    private readonly budget: number = MEMORY_CHAR_BUDGET,
    private readonly measure: (text: string) => number = measureInjectedMemoryBlocks,
  ) {}

  /** Keep the newest record per check-in identity, then suppress sent winners. */
  collapseCheckinGroups<T extends { id: string; ts: number }>(
    entries: T[],
    identityKeyFor: (entry: T) => string | null | undefined,
    sentKeys: ReadonlySet<string>,
  ): CheckinCollapseResult<T> {
    const newestByIdentity = new Map<string, T>();
    const unkeyed: T[] = [];

    for (const entry of entries) {
      const identity = identityKeyFor(entry);
      if (!identity) {
        unkeyed.push(entry);
        continue;
      }
      const previous = newestByIdentity.get(identity);
      if (!previous || entry.ts > previous.ts || (entry.ts === previous.ts && entry.id > previous.id)) {
        newestByIdentity.set(identity, entry);
      }
    }

    const newest = [...newestByIdentity.values()];
    const groupedCount = entries.length - unkeyed.length;
    const collapsed = groupedCount - newest.length;
    return {
      entries: [...unkeyed, ...newest]
        .filter((entry) => !sentKeys.has(`e:${ entry.id }`))
        .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id)),
      collapsed,
    };
  }

  /** Give each multi-subject episode one owner: deepest lineage, then rank. */
  assignMostSpecificSubject<T extends { keys?: string[] }>(
    entries: T[],
    chosen: ChosenMemorySubject[],
  ): Map<string, T[]> {
    const assigned = new Map<string, T[]>();
    const rankedSubjects = chosen.slice().sort((a, b) => b.depth - a.depth || a.rank - b.rank);
    for (const entry of entries) {
      const owner = rankedSubjects.find((subject) => entry.keys?.includes(subject.slug));
      if (owner) assigned.set(owner.slug, [...(assigned.get(owner.slug) || []), entry]);
    }
    return assigned;
  }

  pack(candidates: MemoryCandidate[], checkinGroupsCollapsed = 0): MemoryBudgetResult {
    const prioritized = candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => this.comparePriority(a.candidate, b.candidate) || a.index - b.index)
      .map(({ candidate }) => candidate);
    const unique = this.deduplicate(prioritized);
    const selected: MemoryCandidate[] = [];
    const shortened = new Set<MemoryCandidate>();
    const emittedKeys = new Set<string>();
    let selectionDeduped = 0;
    let currentMeasured = this.measure(this.render(selected).text);

    for (const candidate of unique.entries) {
      if (candidate.entryKey?.startsWith('e:') && candidate.keys.some((key) => emittedKeys.has(key))) {
        selectionDeduped++;
        continue;
      }
      const shortText = candidate.shortenable && candidate.text.length > ENTRY_SOFT_LIMIT
        ? MemoryBudgetPacker.shortenTimelineEntry(candidate.text)
        : candidate.text;
      if (currentMeasured + shortText.length > this.budget) continue;
      const placed = { ...candidate, text: shortText };
      selected.push(placed);
      const measured = this.measure(this.render(selected).text);
      if (measured <= this.budget) {
        currentMeasured = measured;
        if (shortText !== candidate.text) shortened.add(placed);
        for (const key of candidate.keys) emittedKeys.add(key);
        continue;
      }
      selected.pop();
    }

    const rendered = this.render(selected);
    const sectionSizes: Record<string, number> = Object.fromEntries(
      [...new Set(candidates.map((candidate) => candidate.page))].map((page) => [page, rendered.sections[page] || 0]),
    );
    const keys = [...new Set(selected
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => a.candidate.order - b.candidate.order || a.index - b.index)
      .flatMap(({ candidate }) => candidate.keys))];
    return {
      text: rendered.text,
      keys,
      stats: {
        sections: sectionSizes,
        dropped: unique.entries.length - selected.length - selectionDeduped,
        deduped: unique.deduped + selectionDeduped,
        shortened: shortened.size,
        checkinGroupsCollapsed,
        brainCharacters: rendered.text.length,
        measuredCharacters: this.measure(rendered.text),
      },
    };
  }

  /** B4: preserve the date and whole opening sentences; never split a word. */
  static shortenTimelineEntry(entry: string): string {
    if (entry.length <= ENTRY_SOFT_LIMIT) return entry;
    const datedPrefix = entry.match(/^(\s*(?:-\s*(?:Came from:\s*)?)?\[\d{4}-\d{2}-\d{2}\]\s*)/);
    const prefix = datedPrefix?.[1] || '';
    const body = entry.slice(prefix.length).trimStart();
    const targetBodyLength = Math.max(0, ENTRY_SHORT_LIMIT - prefix.length - 2);
    const sentences = body.match(/[^.!?]+[.!?]+(?:["'’”)}\]]*)?(?:\s+|$)|[^.!?]+$/g) || [body];
    let kept = '';
    for (const sentence of sentences) {
      const next = `${ kept }${ sentence }`;
      if (next.trimEnd().length > targetBodyLength) break;
      kept = next;
    }
    if (!kept.trim()) {
      const words = body.split(/\s+/);
      const chosen: string[] = [];
      for (const word of words) {
        const next = [...chosen, word].join(' ');
        if (next.length > targetBodyLength) break;
        chosen.push(word);
      }
      kept = chosen.join(' ');
    }
    return `${ prefix }${ kept.trimEnd() } …`;
  }

  private comparePriority(a: MemoryCandidate, b: MemoryCandidate): number {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.tier === 3) return b.ts - a.ts || b.score - a.score || a.order - b.order;
    return (a.priorityOrder ?? a.order) - (b.priorityOrder ?? b.order) || b.score - a.score || b.ts - a.ts;
  }

  private deduplicate(candidates: MemoryCandidate[]): { entries: MemoryCandidate[]; deduped: number } {
    const kept: MemoryCandidate[] = [];
    const entryKeys = new Set<string>();
    const exactTexts = new Set<string>();
    const normalized: string[] = [];
    const trigrams = new Map<string, number[]>();
    let deduped = 0;

    for (const candidate of candidates) {
      if (candidate.entryKey && entryKeys.has(candidate.entryKey)) {
        deduped++;
        continue;
      }
      const text = MemoryBudgetPacker.normalize(candidate.text);
      const grams = MemoryBudgetPacker.wordTrigrams(text);
      const possible = new Set<number>();
      for (const gram of grams) for (const index of trigrams.get(gram) || []) possible.add(index);
      let duplicate = exactTexts.has(text);
      if (!duplicate && grams.size) {
        duplicate = [...possible].some((index) => {
          const otherGrams = MemoryBudgetPacker.wordTrigrams(normalized[index]);
          return MemoryBudgetPacker.jaccard(grams, otherGrams) >= 0.8;
        });
      }
      if (duplicate) {
        deduped++;
        continue;
      }
      const index = kept.length;
      kept.push(candidate);
      normalized.push(text);
      exactTexts.add(text);
      if (candidate.entryKey) entryKeys.add(candidate.entryKey);
      for (const gram of grams) trigrams.set(gram, [...(trigrams.get(gram) || []), index]);
    }
    return { entries: kept, deduped };
  }

  private render(candidates: MemoryCandidate[]): { text: string; sections: Record<string, number> } {
    const ordered = candidates
      .map((candidate, index) => ({ candidate, index }))
      .sort((a, b) => a.candidate.order - b.candidate.order || a.index - b.index)
      .map(({ candidate }) => candidate);
    const pageRows = new Map<string, MemoryCandidate[]>();
    for (const candidate of ordered) pageRows.set(candidate.page, [...(pageRows.get(candidate.page) || []), candidate]);

    const pageBlocks: string[] = [];
    const sections: Record<string, number> = {};
    for (const rows of pageRows.values()) {
      const pageHeader = rows[0].pageHeader.trim();
      const bodies: string[] = [];
      let section = '';
      let sectionHeader = '';
      let sectionRows: string[] = [];
      const flushSection = () => {
        if (!sectionRows.length) return;
        bodies.push(sectionHeader ? `${ sectionHeader.trim() }\n${ sectionRows.join('\n') }` : sectionRows.join('\n'));
        sectionRows = [];
      };
      for (const row of rows) {
        if (sectionRows.length && row.section !== section) flushSection();
        if (!sectionRows.length) {
          section = row.section;
          sectionHeader = row.sectionHeader;
        }
        sectionRows.push(row.text);
      }
      flushSection();
      const block = pageHeader ? `${ pageHeader }\n\n${ bodies.join('\n\n') }` : bodies.join('\n\n');
      pageBlocks.push(block);
      sections[rows[0].page] = block.length;
    }
    return { text: pageBlocks.join('\n\n'), sections };
  }

  private static normalize(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  private static wordTrigrams(text: string): Set<string> {
    const words = text.split(' ').filter(Boolean);
    const result = new Set<string>();
    for (let index = 0; index + 2 < words.length; index++) result.add(words.slice(index, index + 3).join(' '));
    return result;
  }

  private static jaccard(a: Set<string>, b: Set<string>): number {
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const value of a) if (b.has(value)) intersection++;
    return intersection / (a.size + b.size - intersection);
  }
}

/** Emits only section-size metadata; recalled text is never logged. */
export class MemoryBudgetLog {
  constructor(private readonly writeLine: (line: string) => void) {}

  write(input: MemoryBudgetLogInput): void {
    const sections = input.stats?.sections || {};
    const sectionSize = (name: string) => sections[name] || 0;
    const projectSections = Object.entries(sections)
      .filter(([name]) => name.startsWith('project:'))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, size]) => `${ name }=${ size }`);
    const total = measureInjectedMemoryBlocks(input.brain);
    const fields = [
      `[MemoryBudget]`,
      `thread=${ input.threadId || 'unknown' }`,
      `skills=${ sectionSize('skills') }`,
      `sulla=${ sectionSize('sulla') }`,
      `human=${ sectionSize('human') }`,
      ...projectSections,
      `lessons=${ sectionSize('lessons') }`,
      `brain=${ input.brain.trim().length }`,
      `total=${ total }`,
      `cap=${ MEMORY_CHAR_BUDGET }`,
      `dropped=${ input.stats?.dropped || 0 }`,
      `deduped=${ input.stats?.deduped || 0 }`,
      `shortened=${ input.stats?.shortened || 0 }`,
      `checkinGroupsCollapsed=${ input.stats?.checkinGroupsCollapsed || 0 }`,
      `team_directory=${ (input.teamDirectory || '').trim().length }`,
      `installed_skills=${ (input.installedSkills || '').trim().length }`,
      `subagent_directory=${ (input.subagentDirectory || '').trim().length }`,
    ];
    this.writeLine(fields.join(' '));
  }
}
