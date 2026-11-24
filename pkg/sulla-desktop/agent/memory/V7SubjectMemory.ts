// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../database/PostgresClient';
import { SubjectMemorySentModel } from '../database/models/SubjectMemorySentModel';
import { POTION_MODEL_NAME } from './MemoryRecallService';
import { PotionEmbedder } from './potionEmbedder';
import { resolveBundledModelDir } from '../utils/sullaPaths';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';
import { CheckinIdentity } from './CheckinIdentity';
import {
  MEMORY_CHAR_BUDGET,
  MemoryBudgetPacker,
  measureInjectedMemoryBlocks,
  type MemoryBudgetResult,
  type MemoryCandidate,
} from './MemoryBudget';

interface Subject {
  slug: string;
  kind: string;
  name: string;
  parent: string | null;
  aliases: string[];
}
export interface Episode {
  id: string;
  ts: number;
  conversationId?: string | null;
  source: string;
  text: string;
  keys: string[];
  sentiment?: string | null;
}
interface Item {
  id: string;
  kind: 'policy' | 'conclusion';
  ptype: string | null;
  text: string;
  why: string | null;
  scope: string[];
  ts: number;
  always_on: boolean;
  confirmed: boolean;
  supersedes: string | null;
  origin: string;
}
interface Skill {
  slug: string;
  version_ts: number;
  label: string;
  trigger_when: string;
  trigger_actions: string[];
  trigger_phrases: string[];
  body: string;
  strength: number;
}
export interface V7SubjectMemoryCache {
  signature: string;
  subjects: Map<string, Subject>;
  episodes: Episode[];
  checkinIdentities: Map<string, string | null>;
  items: Item[];
  evidence: Map<string, string[]>;
  overviews: Map<string, { ts: number; text: string }[]>;
  skills: Skill[];
  epVectors: Map<string, Float32Array>;
  itemVectors: Map<string, Float32Array>;
  skillVectors: Map<string, Float32Array>;
  subjectVectors: Map<string, Float32Array>;
}

type Cache = V7SubjectMemoryCache;

let model: PotionEmbedder | null | undefined;
let cache: Cache | null = null;
let refresh: Promise<Cache> | null = null;
const dot = (a: Float32Array, b: Float32Array) => {
  let n = 0;
  for (let i = 0; i < a.length; i++) n += a[i] * b[i];
  return n;
};
// pg returns BIGINT columns as strings, so coerce before building a Date.
const day = (ms: number | string) => new Date(Number(ms)).toISOString().slice(0, 10);
const EMBEDDING_CHUNK_SIZE = 200;

function nextTick(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

/** Keep cold-start embedding work off any single Electron main-process tick. */
async function embedMissingRows(next: Cache, e: PotionEmbedder): Promise<void> {
  const work: Array<() => void> = [];

  for (const episode of next.episodes) {
    if (!next.epVectors.has(episode.id)) {
      work.push(() => next.epVectors.set(episode.id, e.embed(episode.text)));
    }
  }
  for (const item of next.items) {
    if (!next.itemVectors.has(item.id)) {
      work.push(() => next.itemVectors.set(item.id, e.embed(`${ item.text } ${ item.why || '' }`)));
    }
  }
  for (const subject of next.subjects.values()) {
    if (!['global', 'major'].includes(subject.kind) && !next.subjectVectors.has(subject.slug)) {
      const overview = (next.overviews.get(subject.slug) || []).at(-1)?.text || '';
      work.push(() => next.subjectVectors.set(subject.slug, e.embed(`${ subject.name }. ${(subject.aliases || []).join('. ')}. ${ overview }`)));
    }
  }
  for (const skill of next.skills) {
    const key = `${ skill.slug }@${ skill.version_ts }`;
    if (!next.skillVectors.has(key)) {
      work.push(() => next.skillVectors.set(key, e.embed(`${ skill.label }. ${ skill.trigger_when }`)));
    }
  }

  for (let offset = 0; offset < work.length; offset += EMBEDDING_CHUNK_SIZE) {
    await nextTick();
    for (const embed of work.slice(offset, offset + EMBEDDING_CHUNK_SIZE)) embed();
  }
}

function embedder(): PotionEmbedder | null {
  if (model !== undefined) return model;
  try {
    const dir = resolveBundledModelDir(POTION_MODEL_NAME);
    model = dir ? PotionEmbedder.load(dir) : null;
  } catch {
    model = null;
  }
  return model;
}

async function signature(): Promise<string> {
  const r = await postgresClient.query<{ sig: string }>(
    `SELECT concat_ws('|',(SELECT count(*)||':'||coalesce(max(ts),0)||':'||count(*) FILTER (WHERE superseded_by IS NOT NULL) FROM subject_memory.episodes),(SELECT count(*)||':'||coalesce(max(ts),0) FROM subject_memory.items),(SELECT count(*)||':'||coalesce(max(version_ts),0) FROM subject_memory.skills),(SELECT count(*)||':'||coalesce(max(ts),0) FROM subject_memory.overviews),(SELECT count(*)||':'||coalesce(max(updated_ts),0) FROM subject_memory.subjects)) sig`
  );
  return r[0]?.sig || '';
}

async function load(): Promise<Cache> {
  const sig = await signature();
  if (cache?.signature === sig) return cache;
  if (refresh) return refresh;
  refresh = (async () => {
    const [subjects, episodes, items, evidence, overviews, skills] =
      await Promise.all([
        postgresClient.query<Subject>(
          'SELECT slug,kind,name,parent,aliases FROM subject_memory.subjects'
        ),
        postgresClient.query<Episode>(
          'SELECT id,ts,conversation_id AS "conversationId",source,text,keys,sentiment FROM subject_memory.episodes WHERE superseded_by IS NULL ORDER BY id'
        ),
        postgresClient.query<Item>(
          'SELECT * FROM subject_memory.current_items()'
        ),
        postgresClient.query<{ episode_id: string; item_id: string }>(
          'SELECT episode_id,item_id FROM subject_memory.evidence'
        ),
        postgresClient.query<{ subject: string; ts: number; text: string }>(
          'SELECT subject,ts,text FROM subject_memory.overviews ORDER BY subject,ts'
        ),
        postgresClient.query<Skill>(
          "SELECT * FROM subject_memory.skills_at((extract(epoch from now())*1000)::bigint) WHERE status='active'"
        ),
      ]);
    const previous = cache;
    const e = embedder();
    const next: Cache = {
      signature: sig,
      subjects: new Map(subjects.map((x) => [x.slug, x])),
      episodes,
      checkinIdentities: new Map(episodes.map((episode) => [
        episode.id,
        CheckinIdentity.keyFor({
          id: episode.id,
          text: episode.text,
          source: episode.source,
          keys: episode.keys,
          conversationId: episode.conversationId,
          sentiment: episode.sentiment,
        }),
      ] as const)),
      items,
      evidence: new Map(),
      overviews: new Map(),
      skills,
      epVectors: new Map(),
      itemVectors: new Map(),
      skillVectors: new Map(),
      subjectVectors: new Map(),
    };
    for (const x of evidence)
      next.evidence.set(x.episode_id, [
        ...(next.evidence.get(x.episode_id) || []),
        x.item_id,
      ]);
    for (const x of overviews)
      next.overviews.set(x.subject, [
        ...(next.overviews.get(x.subject) || []),
        x,
      ]);
    // Reuse unchanged vectors immediately. Missing vectors are filled off the reply path.
    if (previous) {
      next.epVectors = previous.epVectors;
      next.itemVectors = previous.itemVectors;
      next.skillVectors = previous.skillVectors;
      next.subjectVectors = previous.subjectVectors;
    }
    if (e) {
      void embedMissingRows(next, e).catch(error => {
        console.warn('[V7SubjectMemory] Background embedding failed:', error instanceof Error ? error.message : error);
      });
    }
    cache = next;
    return next;
  })();
  try {
    return await refresh;
  } finally {
    refresh = null;
  }
}

function lineage(c: Cache, slug: string): string[] {
  const out: string[] = [];
  while (slug && c.subjects.has(slug) && !out.includes(slug)) {
    out.push(slug);
    slug = c.subjects.get(slug)!.parent || '';
  }
  return out;
}
function itemLine(i: Item, sent: Set<string>, origin?: Episode) {
  const tag: { [k: string]: string } = {
    do: 'DO',
    dont: "DON'T",
    preference: 'PREFER',
    direction: 'DECIDED',
    lesson: 'LESSON',
  };
  let s = `- **${tag[i.ptype || ''] || 'TRUE'}** ${i.text}${
    i.why ? ` _Why: ${i.why}_` : ''
  }${i.confirmed ? '' : ' (tentative)'} [${day(Number(i.ts))}]`;
  if (i.supersedes && sent.has(`i:${i.supersedes}`))
    s += ' _(replaces the earlier version you were given; follow this one)_';
  if (origin && !sent.has(`e:${origin.id}`)) {
    const originLine = `  - Came from: [${day(origin.ts)}] ${origin.text}`;
    s += `\n${ originLine.length > 400 ? MemoryBudgetPacker.shortenTimelineEntry(originLine) : originLine }`;
  }
  return s;
}

export interface V7SubjectMemoryDependencies {
  load?: () => Promise<V7SubjectMemoryCache>;
  embedder?: () => PotionEmbedder | null;
  packer?: MemoryBudgetPacker;
  sentLedger?: Pick<SubjectMemorySentModel, 'clearThread' | 'deleteExpiredBatch' | 'activeKeys' | 'record'>;
  getPrimaryUserName?: () => Promise<string>;
}

export interface V7SubjectMemoryOptions {
  budget?: number;
  measureBrain?: (brain: string) => number;
  dependencies?: V7SubjectMemoryDependencies;
}

/** Mechanical v7 recall packed as whole entries under the injected-memory cap. */
export async function recallV7SubjectMemory(
  context: string[],
  threadId: string,
  reset = false,
  options: V7SubjectMemoryOptions = {},
): Promise<MemoryBudgetResult | null> {
  const dependencies = options.dependencies || {};
  const c = await (dependencies.load || load)();
  const e = (dependencies.embedder || embedder)();
  if (!e) return null;
  const measureBrain = options.measureBrain || ((brain: string) => measureInjectedMemoryBlocks('', brain));
  const packer = dependencies.packer || new MemoryBudgetPacker(options.budget ?? MEMORY_CHAR_BUDGET, measureBrain);
  const cue = context.join('\n');
  const q = e.embed(cue);
  const sentLedger = dependencies.sentLedger || new SubjectMemorySentModel();
  if (reset) await sentLedger.clearThread(threadId);
  await sentLedger.deleteExpiredBatch();
  const sent = await sentLedger.activeKeys(threadId);
  const lexical = new Set(
    cue
      .toLowerCase()
      .split(/\W+/)
      .filter((x) => x.length > 3)
  );
  const scoreText = (t: string) =>
    t
      .toLowerCase()
      .split(/\W+/)
      .reduce((n, x) => n + (lexical.has(x) ? 1 : 0), 0);
  const episodes = packer.collapseCheckinGroups(
    c.episodes,
    (episode) => c.checkinIdentities.get(episode.id),
    sent,
  );
  const hits = episodes.entries
    .map((x) => ({
      x,
      s: c.epVectors.get(x.id)
        ? dot(c.epVectors.get(x.id)!, q)
        : scoreText(x.text) / 20,
    }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 40);
  const episodeSubjectScore = new Map<string, number>();
  for (const [rank, h] of hits.entries())
    for (const k of h.x.keys || [])
      if (!['global', 'major'].includes(c.subjects.get(k)?.kind || ''))
        episodeSubjectScore.set(k, (episodeSubjectScore.get(k) || 0) + h.s / (1 + rank / 10));
  const loweredCue = cue.toLowerCase();
  const subjectCandidates = [...c.subjects.values()]
    .filter(s => !['global', 'major'].includes(s.kind))
    .map(s => {
      const literal = [s.name, ...(s.aliases || [])].some(n => n.length > 3 && loweredCue.includes(n.toLowerCase()));
      const episode = episodeSubjectScore.get(s.slug) || 0;
      const vector = c.subjectVectors.get(s.slug) ? dot(c.subjectVectors.get(s.slug)!, q) : scoreText(`${s.name} ${(s.aliases || []).join(' ')}`) / 20;
      return { slug:s.slug, literal, episode, vector, score:episode + (literal ? 2 : 0) + vector * 0.45 };
    })
    .sort((a,b) => b.score-a.score);
  const chosen: string[] = [];
  let vectorOnly = 0;
  for (const candidate of subjectCandidates) {
    const only = !candidate.literal && candidate.episode <= 0;
    if (only && vectorOnly >= 2) continue;
    if (only) vectorOnly++;
    chosen.push(candidate.slug);
    if (chosen.length === 5) break;
  }
  const via = new Map<string, number>(),
    origin = new Map<string, Episode>();
  hits.forEach((h, rank) =>
    (c.evidence.get(h.x.id) || []).forEach((id) => {
      via.set(id, (via.get(id) || 0) + h.s / (1 + rank / 10));
      if (!origin.has(id)) origin.set(id, h.x);
    })
  );
  const itemScore = (i: Item) =>
    (via.get(i.id) || 0) * 2 +
    (c.itemVectors.get(i.id)
      ? dot(c.itemVectors.get(i.id)!, q)
      : scoreText(`${i.text} ${i.why || ''}`) / 20);
  const ranked = c.items
    .filter((i) => !sent.has(`i:${i.id}`))
    .sort((a, b) => itemScore(b) - itemScore(a));
  const used = new Set<string>();
  const take = (f: (i: Item) => boolean, n: number) =>
    ranked
      .filter((i) => !used.has(i.id) && f(i))
      .slice(0, n)
      .map((i) => (used.add(i.id), i));
  const always = take((i) => i.always_on && i.origin !== 'seeded', 50);
  const global = take((i) => i.origin !== 'seeded' && i.kind === 'policy' && i.scope.includes('global'), 60);
  const facts = take(
    (i) => i.origin !== 'seeded' && i.kind === 'conclusion' && i.scope.includes('global'),
    25
  );
  const sullaSeed = take((i) => i.origin === 'seeded' && i.scope.some(scope => scope === 'sulla' || scope === 'global'), 100);
  const projectRows = chosen.map((slug) => {
    const subject = c.subjects.get(slug)!;
    const line = lineage(c, slug);
    const major = line.filter((x) => c.subjects.get(x)?.kind === 'major');
    const majorRules = take((i) => i.kind === 'policy' && i.scope.some((x) => major.includes(x)), 25);
    const rules = take((i) => i.kind === 'policy' && i.scope.some((x) => line.includes(x)), 40);
    const conclusions = take((i) => i.kind === 'conclusion' && i.scope.some((x) => line.includes(x)), 25);
    return {
      slug,
      subject,
      line,
      majorRules,
      rules,
      conclusions,
      overview: (c.overviews.get(slug) || []).at(-1),
    };
  });
  const chosenSubjects = chosen.map((slug, rank) => ({ slug, depth: lineage(c, slug).length, rank }));
  const assignedEpisodes = packer.assignMostSpecificSubject(episodes.entries, chosenSubjects);
  const hitsById = new Map(hits.map((hit) => [hit.x.id, hit.s]));
  const projectRecentBySlug = new Map<string, Episode[]>();
  const standaloneEpisodeIds = new Set<string>();
  for (const row of projectRows) {
    const recent = (assignedEpisodes.get(row.slug) || [])
      .filter((episode) => episode.keys?.includes(row.slug))
      .sort((a, b) => b.ts - a.ts || (hitsById.get(b.id) || 0) - (hitsById.get(a.id) || 0))
      .slice(0, 25)
      .reverse();
    projectRecentBySlug.set(row.slug, recent);
    recent.forEach((episode) => standaloneEpisodeIds.add(episode.id));
  }
  const history = hits
    .filter((hit) => !standaloneEpisodeIds.has(hit.x.id))
    .sort((a, b) => b.x.ts - a.x.ts || b.s - a.s)
    .slice(0, 20)
    .reverse()
    .map((hit) => hit.x);
  history.forEach((episode) => standaloneEpisodeIds.add(episode.id));
  const projectRuleItems: Array<{ slug: string; item: Item }> = [];
  for (let index = 0; projectRows.some((row) => index < Math.max(row.majorRules.length, row.rules.length)); index++) {
    for (const row of projectRows) {
      if (row.majorRules[index]) projectRuleItems.push({ slug: row.slug, item: row.majorRules[index] });
      if (row.rules[index]) projectRuleItems.push({ slug: row.slug, item: row.rules[index] });
    }
  }
  const priority = new Map<string, number>();
  let nextPriority = 0;
  for (const item of [...always, ...global]) priority.set(item.id, nextPriority++);
  for (const row of projectRuleItems) priority.set(row.item.id, nextPriority++);
  for (const item of sullaSeed) priority.set(item.id, nextPriority++);
  const skills = c.skills
    .map((s) => ({
      s,
      v:
        (c.skillVectors.get(`${s.slug}@${s.version_ts}`)
          ? dot(c.skillVectors.get(`${s.slug}@${s.version_ts}`)!, q)
          : scoreText(
              `${s.trigger_when} ${(s.trigger_phrases || []).join(' ')}`
            ) / 20) +
        0.15 *
          (s.trigger_phrases || []).filter((p) =>
            loweredCue.includes(p.toLowerCase().trim().replace(/\s+/g, ' '))
          ).length +
        0.01 * Math.min(s.strength, 10),
    }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 4)
    .filter((x) => !sent.has(`s:${x.s.slug}@${x.s.version_ts}`))
    .map((x) => x.s);
  for (const skill of skills) priority.set(`skill:${skill.slug}@${skill.version_ts}`, nextPriority++);

  let primaryUserName = 'your human';
  try {
    primaryUserName = String(await (dependencies.getPrimaryUserName || (() => SullaSettingsModel.get('primaryUserName', '')))() || '').trim() || primaryUserName;
  } catch { /* Settings may not be bootstrapped in an isolated evaluator. */ }

  const candidates: MemoryCandidate[] = [];
  let displayOrder = 0;
  const add = (candidate: Omit<MemoryCandidate, 'order'>) => candidates.push({ ...candidate, order: displayOrder++ });
  const humanHeader = `## human.md — how ${ primaryUserName } wants Sulla to work everywhere`;
  const includedOriginIds = new Set<string>();
  const addItems = (rows: Item[], page: string, pageHeader: string, section: string, sectionHeader: string, tier: number, priorityFor: (item: Item) => number | undefined) => {
    for (const item of rows) {
      const sourceEpisode = origin.get(item.id);
      const episodeOrigin = sourceEpisode && !standaloneEpisodeIds.has(sourceEpisode.id) && !includedOriginIds.has(sourceEpisode.id)
        ? sourceEpisode
        : undefined;
      const hasOrigin = Boolean(episodeOrigin && !sent.has(`e:${episodeOrigin.id}`));
      if (hasOrigin) includedOriginIds.add(episodeOrigin!.id);
      add({
        page, pageHeader, section, sectionHeader,
        keys: [`i:${item.id}`, ...(hasOrigin ? [`e:${episodeOrigin!.id}`] : [])],
        tier, priorityOrder: priorityFor(item), score: itemScore(item), ts: item.ts,
        text: itemLine(item, sent, episodeOrigin), entryKey: `i:${item.id}`,
      });
    }
  };
  for (const skill of skills) add({
    page: 'skills', pageHeader: '## skills.md — your own habits that apply now',
    section: `skill:${skill.slug}@${skill.version_ts}`,
    sectionHeader: `### ${skill.label}\n_Trigger: ${skill.trigger_when}_`,
    keys: [`s:${skill.slug}@${skill.version_ts}`], tier: 1,
    priorityOrder: priority.get(`skill:${skill.slug}@${skill.version_ts}`), score: 0, ts: skill.version_ts,
    text: skill.body, entryKey: `s:${skill.slug}@${skill.version_ts}`,
  });
  addItems(sullaSeed, 'sulla', '## sulla.md — how Sulla works', 'Shipped rules and facts', '### Shipped rules and facts', 1, (item) => priority.get(item.id));
  addItems(always, 'human', humanHeader, 'Always', '### Always', 1, (item) => priority.get(item.id));
  addItems(global, 'human', humanHeader, 'Standing rules and preferences', '### Standing rules and preferences', 1, (item) => priority.get(item.id));
  addItems(facts, 'human', humanHeader, 'Known facts', '### Known facts', 2, () => nextPriority++);

  for (const row of projectRows) {
    const subjectLine = row.line.slice().reverse().map((x) => c.subjects.get(x)!.name).join(' > ');
    const page = `project:${row.slug}`;
    const pageHeader = `## project-${row.slug}.md — ${row.subject.name}\n_${subjectLine}_`;
    const overview = row.overview;
    if (overview && !sent.has(`o:${row.slug}@${overview.ts}`)) add({
      page, pageHeader, section: '', sectionHeader: '', keys: [`o:${row.slug}@${overview.ts}`],
      tier: 2, priorityOrder: nextPriority++, score: 0, ts: overview.ts,
      text: overview.text, entryKey: `o:${row.slug}@${overview.ts}`,
    });
    addItems(row.majorRules, page, pageHeader, 'Rules for this kind of work', '### Rules for this kind of work', 1, (item) => priority.get(item.id));
    addItems(row.rules, page, pageHeader, 'Rules and decisions for this subject', '### Rules and decisions for this subject', 1, (item) => priority.get(item.id));
    addItems(row.conclusions, page, pageHeader, "What's true", "### What's true", 2, () => nextPriority++);
  }

  for (const row of projectRows) {
    for (const episode of projectRecentBySlug.get(row.slug) || []) {
      add({
        page: `project:${row.slug}`,
        pageHeader: `## project-${row.slug}.md — ${row.subject.name}\n_${row.line.slice().reverse().map((x) => c.subjects.get(x)!.name).join(' > ')}_`,
        section: 'Recent timeline', sectionHeader: '### Recent timeline',
        keys: [`e:${episode.id}`], tier: 3, score: hitsById.get(episode.id) || 0, ts: episode.ts,
        text: `- [${day(episode.ts)}] ${episode.text}`, entryKey: `e:${episode.id}`, shortenable: true,
      });
    }
  }

  for (const episode of history) add({
    page: 'lessons', pageHeader: '## lessons.md — past moments like this one',
    section: '', sectionHeader: '', keys: [`e:${episode.id}`], tier: 3,
    score: hitsById.get(episode.id) || 0, ts: episode.ts,
    text: `- [${day(episode.ts)}] ${episode.text}`, entryKey: `e:${episode.id}`, shortenable: true,
  });

  const result = packer.pack(candidates, episodes.collapsed);
  await sentLedger.record(threadId, result.keys);
  return result;
}

/** Load the store and finish embedding it, so the next recall uses vectors rather than keywords. */
export async function warmV7SubjectMemory(): Promise<void> {
  const c = await load();
  const e = embedder();
  if (e) await embedMissingRows(c, e);
}

export function resetV7SubjectMemoryCache(): void {
  cache = null;
  refresh = null;
}
