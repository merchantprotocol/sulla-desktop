// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../database/PostgresClient';
import { POTION_MODEL_NAME } from './MemoryRecallService';
import { PotionEmbedder } from './potionEmbedder';
import { resolveBundledModelDir } from '../utils/sullaPaths';
import { SullaSettingsModel } from '../database/models/SullaSettingsModel';

export const DEFAULT_SUBCONSCIOUS_RECALL_MODE = 'v7' as const;

interface Subject {
  slug: string;
  kind: string;
  name: string;
  parent: string | null;
  aliases: string[];
}
interface Episode {
  id: string;
  ts: number;
  text: string;
  keys: string[];
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
interface Cache {
  signature: string;
  subjects: Map<string, Subject>;
  episodes: Episode[];
  items: Item[];
  evidence: Map<string, string[]>;
  overviews: Map<string, { ts: number; text: string }[]>;
  skills: Skill[];
  epVectors: Map<string, Float32Array>;
  itemVectors: Map<string, Float32Array>;
  skillVectors: Map<string, Float32Array>;
  subjectVectors: Map<string, Float32Array>;
}

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
    `SELECT concat_ws('|',(SELECT count(*)||':'||coalesce(max(ts),0) FROM subject_memory.episodes),(SELECT count(*)||':'||coalesce(max(ts),0) FROM subject_memory.items),(SELECT count(*)||':'||coalesce(max(version_ts),0) FROM subject_memory.skills),(SELECT count(*)||':'||coalesce(max(ts),0) FROM subject_memory.overviews),(SELECT count(*)||':'||coalesce(max(updated_ts),0) FROM subject_memory.subjects)) sig`
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
          'SELECT id,ts,text,keys FROM subject_memory.episodes ORDER BY id'
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
  if (origin && !sent.has(`e:${origin.id}`))
    s += `\n  - Came from: ${origin.text}`;
  return s;
}

/** Mechanical v7 recall. Documents are intentionally not squeezed into the old 10k budget. */
export async function recallV7SubjectMemory(
  context: string[],
  threadId: string,
  reset = false
): Promise<string | null> {
  const c = await load(),
    e = embedder();
  if (!e) return null;
  const cue = context.join('\n');
  const q = e.embed(cue);
  if (reset)
    await postgresClient.query(
      'UPDATE subject_memory.sent SET cleared=true WHERE thread_id=$1',
      [threadId]
    );
  const sentRows = await postgresClient.query<{ key: string }>(
    'SELECT key FROM subject_memory.sent WHERE thread_id=$1 AND cleared=false',
    [threadId]
  );
  const sent = new Set(sentRows.map((x) => x.key));
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
  const hits = c.episodes
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
  const candidates = [...c.subjects.values()]
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
  for (const candidate of candidates) {
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
  const sullaSeed = take((i) => i.origin === 'seeded' && i.scope.some(scope => scope === 'sulla' || scope === 'global'), 100),
    always = take((i) => i.always_on && i.origin !== 'seeded', 50),
    global = take((i) => i.origin !== 'seeded' && i.kind === 'policy' && i.scope.includes('global'), 60),
    facts = take(
      (i) => i.origin !== 'seeded' && i.kind === 'conclusion' && i.scope.includes('global'),
      25
    );
  const docs: string[] = [];
  const section = (title: string, rows: Item[]) =>
    rows.length
      ? `\n### ${title}\n${rows
          .map((i) => itemLine(i, sent, origin.get(i.id)))
          .join('\n')}`
      : '';
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
  if (skills.length)
    docs.push(
      `## skills.md — your own habits that apply now\n\n${skills
        .map((s) => `### ${s.label}\n_Trigger: ${s.trigger_when}_\n\n${s.body}`)
        .join('\n\n')}`
    );
  if (sullaSeed.length)
    docs.push(`## sulla.md — how Sulla works\n${ section('Shipped rules and facts', sullaSeed) }`);
  let primaryUserName = 'your human';
  try {
    primaryUserName = String(await SullaSettingsModel.get('primaryUserName', '') || '').trim() || primaryUserName;
  } catch { /* Settings may not be bootstrapped in an isolated evaluator. */ }
  docs.push(
    `## human.md — how ${ primaryUserName } wants Sulla to work everywhere\n${section(
      'Always',
      always
    )}${section('Standing rules and preferences', global)}${section(
      'Known facts',
      facts
    )}`
  );
  const shownEpisodes = new Set<string>();
  const shownOverviews: string[] = [];
  for (const slug of chosen) {
    const s = c.subjects.get(slug)!;
    const line = lineage(c, slug),
      major = line.filter((x) => c.subjects.get(x)?.kind === 'major');
    const majorRules = take(
        (i) => i.kind === 'policy' && i.scope.some((x) => major.includes(x)),
        25
      ),
      rules = take(
        (i) => i.kind === 'policy' && i.scope.some((x) => line.includes(x)),
        40
      ),
      conclusions = take(
        (i) => i.kind === 'conclusion' && i.scope.some((x) => line.includes(x)),
        25
      );
    let d = `## project-${s.slug}.md — ${s.name}\n_${line
      .slice()
      .reverse()
      .map((x) => c.subjects.get(x)!.name)
      .join(' > ')}_\n`;
    const ov = (c.overviews.get(slug) || []).at(-1);
    if (ov && !sent.has(`o:${slug}@${ov.ts}`)) {
      d += `\n${ov.text}\n`;
      shownOverviews.push(`o:${slug}@${ov.ts}`);
    }
    d +=
      section('Rules for this kind of work', majorRules) +
      section('Rules and decisions for this subject', rules) +
      section("What's true", conclusions);
    const recent = c.episodes
      .filter((x) => x.keys?.includes(slug) && !sent.has(`e:${x.id}`))
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 25);
    if (recent.length)
      d += `\n### Recent timeline\n${recent
        .reverse()
        .map((x) => `- [${day(x.ts)}] ${x.text}`)
        .join('\n')}`;
    recent.forEach((x) => shownEpisodes.add(x.id));
    docs.push(d);
  }
  const history = hits
    .map((x) => x.x)
    .filter((x) => !sent.has(`e:${x.id}`) && !shownEpisodes.has(x.id))
    .slice(0, 20);
  if (history.length)
    docs.push(
      `## lessons.md — past moments like this one\n${history
        .reverse()
        .map((x) => `- [${day(x.ts)}] ${x.text}`)
        .join('\n')}`
    );
  const keys = [...used].map((x) => `i:${x}`);
  shownEpisodes.forEach((x) => keys.push(`e:${x}`));
  skills.forEach((x) => keys.push(`s:${x.slug}@${x.version_ts}`));
  keys.push(...shownOverviews);
  if (keys.length)
    await postgresClient.query(
      `INSERT INTO subject_memory.sent(thread_id,key,source) SELECT $1,x,'recall' FROM unnest($2::text[]) x ON CONFLICT(thread_id,key) DO UPDATE SET cleared=false,sent_at=now(),source='recall'`,
      [threadId, keys]
    );
  return (
    docs.filter((d) => /^- /m.test(d) || /^### /m.test(d)).join('\n\n') || null
  );
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
