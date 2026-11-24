// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { randomUUID } from 'node:crypto';

import { CheckinIdentity } from './CheckinIdentity';

export const MAX_SWEEP_EPISODES = 5_000;
export const MAX_SWEEP_SUPERSEDES = 1_000;
export const MAX_CROSS_SUBJECT_DELTA_MS = 24 * 60 * 60 * 1_000;

export interface SweepEpisode {
  id: string;
  ts: number;
  conversation_id: string | null;
  source: string;
  sentiment: string | null;
  text: string;
  keys: string[];
  checkin_key: string | null;
  superseded_by: string | null;
  hasEvidence: boolean;
}

export interface SweepSubject {
  slug: string;
  parent: string | null;
  kind: string;
}

/** Intentionally episode-only: the sweeper cannot read or mutate memory items. */
export interface DuplicateSweepStore {
  loadSweepEpisodes(limit: number, beforeTs?: number): Promise<SweepEpisode[]>;
  loadSubjects(): Promise<SweepSubject[]>;
  supersedeEpisode(oldId: string, keepId: string, runId: string, nowTs: number): Promise<boolean>;
}

export interface DuplicateSweepCursor {
  getBeforeTs(): Promise<number | null>;
  setBeforeTs(beforeTs: number | null): Promise<void>;
}

export interface DreamDuplicateSweeperOptions {
  now?: () => number;
  runId?: () => string;
  log?: (line: string) => void;
}

interface SweepStats {
  superseded: number;
  checkinGroups: number;
  crossSubjectDupes: number;
  skippedProtected: number;
  capHit: boolean;
  bySubject: Map<string, number>;
}

interface SubjectRank {
  depth: number;
  slug: string;
}

/** Deterministically collapses protected-safe duplicate episode history without an LLM. */
export class DreamDuplicateSweeper {
  private readonly now: () => number;
  private readonly runId: () => string;
  private readonly log: (line: string) => void;

  constructor(
    private readonly store: DuplicateSweepStore,
    private readonly cursor: DuplicateSweepCursor,
    options: DreamDuplicateSweeperOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now());
    this.runId = options.runId ?? (() => randomUUID());
    this.log = options.log ?? (line => console.log(line));
  }

  async sweep(): Promise<void> {
    const runId = this.runId();
    const newest = await this.store.loadSweepEpisodes(MAX_SWEEP_EPISODES);
    const beforeTs = await this.cursor.getBeforeTs();
    const backlog = beforeTs === null
      ? []
      : await this.store.loadSweepEpisodes(MAX_SWEEP_EPISODES, beforeTs);
    const subjects = await this.store.loadSubjects();
    const episodes = this.uniqueEpisodes([...newest, ...backlog]);
    const ranks = this.subjectRanks(subjects);
    const stats: SweepStats = {
      superseded: 0,
      checkinGroups: 0,
      crossSubjectDupes: 0,
      skippedProtected: 0,
      capHit: false,
      bySubject: new Map(),
    };
    const activeIds = new Set<string>();
    const eligible: SweepEpisode[] = [];

    // Protection is applied before identity/grouping, so protected episodes can never be targets.
    for (const episode of episodes) {
      if (this.isProtected(episode)) {
        stats.skippedProtected++;
      } else if (episode.superseded_by === null) {
        eligible.push(episode);
        activeIds.add(episode.id);
      }
    }

    const checkinKeys = new Map<string, string | null>();
    const checkinGroups = new Map<string, SweepEpisode[]>();
    for (const episode of eligible) {
      const key = this.checkinKey(episode);
      checkinKeys.set(episode.id, key);
      if (!key) continue;
      const group = checkinGroups.get(key) ?? [];
      group.push(episode);
      checkinGroups.set(key, group);
    }

    for (const group of checkinGroups.values()) {
      if (group.length < 2) continue;
      stats.checkinGroups++;
      const keep = [...group].sort((a, b) => this.compareNewest(b, a))[0];
      const older = group
        .filter(episode => episode.id !== keep.id)
        .sort((a, b) => this.compareNewest(a, b));
      for (const episode of older) {
        if (await this.supersede(episode, keep, runId, ranks, stats, activeIds)) break;
      }
      if (stats.capHit) break;
    }

    if (!stats.capHit) {
      const crossGroups = new Map<string, SweepEpisode[]>();
      for (const episode of eligible) {
        if (!activeIds.has(episode.id) || checkinKeys.get(episode.id)) continue;
        const normalized = this.normalizeText(episode.text);
        if (!normalized) continue;
        const group = crossGroups.get(normalized) ?? [];
        group.push(episode);
        crossGroups.set(normalized, group);
      }

      for (const group of crossGroups.values()) {
        if (stats.capHit) break;
        await this.collapseCrossSubjectGroup(group, runId, ranks, stats, activeIds);
      }
    }

    // Do not move the backlog cursor when capped: the same page is retried after this run's writes.
    if (!stats.capHit) {
      if (beforeTs === null) {
        await this.cursor.setBeforeTs(newest.length === MAX_SWEEP_EPISODES ? this.oldestTs(newest) : null);
      } else {
        await this.cursor.setBeforeTs(backlog.length === MAX_SWEEP_EPISODES ? this.oldestTs(backlog) : null);
      }
    }

    const subjectsLog = [...stats.bySubject.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slug, count]) => `subject:${ slug }=${ count }`)
      .join(' ');
    this.log(`[DreamDuplicateSweeper] run=${ runId } superseded=${ stats.superseded }${ subjectsLog ? ` ${ subjectsLog }` : '' } checkinGroups=${ stats.checkinGroups } crossSubjectDupes=${ stats.crossSubjectDupes } skippedProtected=${ stats.skippedProtected } capHit=${ stats.capHit}`);
  }

  private async collapseCrossSubjectGroup(
    episodes: SweepEpisode[],
    runId: string,
    ranks: Map<string, SubjectRank>,
    stats: SweepStats,
    activeIds: Set<string>,
  ): Promise<void> {
    const pending = episodes.filter(episode => activeIds.has(episode.id));
    while (pending.length > 1) {
      const keeper = pending
        .filter(candidate => pending.some(other => this.canCrossSupersede(candidate, other)))
        .sort((a, b) => this.compareSpecificity(a, b, ranks))[0];
      if (!keeper) return;

      const duplicates = pending
        .filter(candidate => this.canCrossSupersede(keeper, candidate))
        .sort((a, b) => this.compareNewest(a, b));
      for (const duplicate of duplicates) {
        const capped = await this.supersede(duplicate, keeper, runId, ranks, stats, activeIds, true);
        const index = pending.findIndex(episode => episode.id === duplicate.id);
        if (index >= 0) pending.splice(index, 1);
        if (capped || stats.capHit) return;
      }
    }
  }

  /** Returns true when the run cap stopped a candidate, not merely when it was reached. */
  private async supersede(
    oldEpisode: SweepEpisode,
    keepEpisode: SweepEpisode,
    runId: string,
    ranks: Map<string, SubjectRank>,
    stats: SweepStats,
    activeIds: Set<string>,
    crossSubject = false,
  ): Promise<boolean> {
    if (stats.superseded >= MAX_SWEEP_SUPERSEDES) {
      stats.capHit = true;
      return true;
    }
    activeIds.delete(oldEpisode.id);
    const changed = await this.store.supersedeEpisode(oldEpisode.id, keepEpisode.id, runId, Math.floor(this.now()));
    if (!changed) return false;

    stats.superseded++;
    if (crossSubject) stats.crossSubjectDupes++;
    const subject = this.primarySubject(oldEpisode, ranks);
    stats.bySubject.set(subject, (stats.bySubject.get(subject) ?? 0) + 1);
    return false;
  }

  private canCrossSupersede(keeper: SweepEpisode, candidate: SweepEpisode): boolean {
    return keeper.id !== candidate.id
      && this.keySet(keeper.keys) !== this.keySet(candidate.keys)
      && Math.abs(keeper.ts - candidate.ts) <= MAX_CROSS_SUBJECT_DELTA_MS;
  }

  private checkinKey(episode: SweepEpisode): string | null {
    return episode.checkin_key ?? CheckinIdentity.keyFor({
      id: episode.id,
      text: episode.text,
      source: episode.source,
      keys: episode.keys,
      conversationId: episode.conversation_id,
      sentiment: episode.sentiment,
    });
  }

  private isProtected(episode: SweepEpisode): boolean {
    if (episode.source.toLowerCase() === 'user') return true;
    if (episode.sentiment !== null && episode.sentiment.toLowerCase() !== 'neutral') return true;
    if (episode.hasEvidence) return true;

    return /\b(?:RULE|DECISION|DECIDED|DO\s+NOT|DON['’]T|PREFER|MUST|NEVER|ALWAYS)\b/i.test(episode.text)
      || /\b(?:Jonathon|the user|user|human|owner)\b.{0,80}\b(?:said|asked|approved|decided|confirmed|requested|chose|wrote|quoted)\b.{0,30}["“'‘]/i.test(episode.text)
      || /(?:^|\n)\s*>?\s*(?:Jonathon|the user|user|human)\s*:\s*["“'‘]/i.test(episode.text);
  }

  private normalizeText(text: string): string {
    return text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  }

  private keySet(keys: string[]): string {
    return [...new Set(keys)].sort().join('\u0000');
  }

  private subjectRanks(subjects: SweepSubject[]): Map<string, SubjectRank> {
    const subjectBySlug = new Map(subjects.map(subject => [subject.slug, subject]));
    const ranks = new Map<string, SubjectRank>();
    for (const subject of subjects) {
      ranks.set(subject.slug, { depth: this.subjectDepth(subject.slug, subjectBySlug), slug: subject.slug });
    }
    return ranks;
  }

  private subjectDepth(slug: string, subjects: Map<string, SweepSubject>): number {
    const first = subjects.get(slug);
    if (!first || first.kind === 'global' || first.kind === 'major') return 0;

    let depth = 0;
    let current: SweepSubject | undefined = first;
    const visited = new Set<string>();
    while (current && !visited.has(current.slug) && current.kind !== 'global' && current.kind !== 'major') {
      visited.add(current.slug);
      depth++;
      current = current.parent ? subjects.get(current.parent) : undefined;
    }
    return depth;
  }

  private primarySubject(episode: SweepEpisode, ranks: Map<string, SubjectRank>): string {
    return episode.keys
      .map(slug => ranks.get(slug) ?? { depth: 0, slug })
      .sort((a, b) => b.depth - a.depth || a.slug.localeCompare(b.slug))[0]?.slug ?? 'unknown';
  }

  private compareSpecificity(a: SweepEpisode, b: SweepEpisode, ranks: Map<string, SubjectRank>): number {
    const rankA = this.primaryRank(a, ranks);
    const rankB = this.primaryRank(b, ranks);
    return rankB.depth - rankA.depth || this.compareNewest(b, a);
  }

  private primaryRank(episode: SweepEpisode, ranks: Map<string, SubjectRank>): SubjectRank {
    return episode.keys
      .map(slug => ranks.get(slug) ?? { depth: 0, slug })
      .sort((a, b) => b.depth - a.depth || a.slug.localeCompare(b.slug))[0] ?? { depth: 0, slug: 'unknown' };
  }

  private compareNewest(a: SweepEpisode, b: SweepEpisode): number {
    return a.ts - b.ts || a.id.localeCompare(b.id);
  }

  private uniqueEpisodes(episodes: SweepEpisode[]): SweepEpisode[] {
    const byId = new Map(episodes.map(episode => [episode.id, episode]));
    return [...byId.values()];
  }

  private oldestTs(episodes: SweepEpisode[]): number | null {
    return episodes.length ? Math.min(...episodes.map(episode => episode.ts)) : null;
  }
}
