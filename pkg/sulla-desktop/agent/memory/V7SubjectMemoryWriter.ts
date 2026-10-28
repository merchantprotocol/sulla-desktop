// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { postgresClient } from '../database/PostgresClient';

const SOURCES = new Set(['user', 'model', 'software', 'observed']);
const SENTIMENTS = new Set([
  'correction',
  'frustration',
  'praise',
  'approval',
  'neutral',
]);
const ITEM_TYPES = new Set(['do', 'dont', 'preference', 'direction', 'lesson']);
const EVIDENCE_ROLES = new Set(['origin', 'reinforces', 'contradicts']);
const ID_PATTERN = /^(\d{13})-([a-z][a-z0-9_-]{0,31})-(\d{1,4})$/;
const MAX_EPISODES = 20;
const MAX_ITEMS = 10;
const MAX_EVIDENCE = 20;

interface SubjectRow {
  slug: string;
  name: string;
  kind: string;
  aliases: string[];
}

interface RuleRow {
  id: string;
  text: string;
  scope: string[];
}

interface ElephantEpisode {
  id: string;
  ts: number;
  conversation_id: string | null;
  source: string;
  text: string;
  keys: string[];
  sentiment: string | null;
  refs: string[];
}

interface ElephantItem {
  id: string;
  ptype: string;
  text: string;
  why: string | null;
  scope: string[];
  ts: number;
  supersedes: string | null;
  always_on: boolean;
}

interface ElephantEvidence {
  item_id: string;
  episode_id: string;
  role: string;
}

interface ElephantWrite {
  episodes: ElephantEpisode[];
  items: ElephantItem[];
  evidence: ElephantEvidence[];
}

function tokens(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []);
}

function subjectScore(
  subject: SubjectRow,
  cue: string,
  cueTokens: Set<string>
): number {
  const names = [subject.slug, subject.name, ...(subject.aliases ?? [])];
  let score = 0;

  for (const name of names) {
    const normalized = name.toLowerCase();
    if (normalized.length > 3 && cue.includes(normalized)) score += 10;
    for (const token of tokens(normalized)) {
      if (cueTokens.has(token)) score += 1;
    }
  }

  return score;
}

/** Context is data for the model, never authority to write outside the schema below. */
export async function buildV7ElephantContext(
  transcript: string
): Promise<string> {
  const subjects = await postgresClient.query<SubjectRow>(`
    SELECT slug, name, kind, aliases
      FROM subject_memory.subjects
     ORDER BY slug`);
  const cue = transcript.toLowerCase();
  const cueTokens = tokens(cue);
  const topSlugs = subjects
    .map((subject) => ({
      subject,
      score: subjectScore(subject, cue, cueTokens),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((candidate) => candidate.subject.slug);
  const rules = topSlugs.length
    ? await postgresClient.query<RuleRow>(
        `
        SELECT id, text, scope
          FROM subject_memory.current_items()
         WHERE kind = 'policy' AND scope && $1::text[]
         ORDER BY ts DESC
         LIMIT 100`,
        [topSlugs]
      )
    : [];

  return JSON.stringify({
    subjects,
    topSubjects: topSlugs,
    currentRules: rules,
  });
}

function parseOutput(response: string): unknown {
  const trimmed = response.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return JSON.parse(fenced?.[1] ?? trimmed);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length)
    throw new Error(
      `${label} contains unsupported fields: ${unexpected.join(', ')}`
    );
}

function boundedString(
  value: unknown,
  label: string,
  max: number,
  nullable = false
): string | null {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new Error(
      `${label} must be a non-empty string of at most ${max} characters`
    );
  }
  return value;
}

function stringArray(value: unknown, label: string, maxItems = 10): string[] {
  if (
    !Array.isArray(value) ||
    value.length > maxItems ||
    value.some((item) => typeof item !== 'string' || !item || item.length > 128)
  ) {
    throw new Error(
      `${label} must be an array of at most ${maxItems} bounded strings`
    );
  }
  return [...new Set(value)];
}

function validateId(id: string, ts: number, source?: string): void {
  const match = id.match(ID_PATTERN);
  if (!match || Number(match[1]) !== ts || (source && match[2] !== source)) {
    throw new Error(`invalid id ${id}; expected <epoch-ms>-<source>-<n>`);
  }
}

async function validateWrite(raw: unknown): Promise<ElephantWrite> {
  const root = asRecord(raw, 'root');
  exactKeys(root, ['episodes', 'items', 'evidence'], 'root');
  if (!Array.isArray(root.episodes) || root.episodes.length > MAX_EPISODES)
    throw new Error('episodes exceeds limit');
  if (!Array.isArray(root.items) || root.items.length > MAX_ITEMS)
    throw new Error('items exceeds limit');
  if (!Array.isArray(root.evidence) || root.evidence.length > MAX_EVIDENCE)
    throw new Error('evidence exceeds limit');

  const subjectRows = await postgresClient.query<{ slug: string }>(
    'SELECT slug FROM subject_memory.subjects'
  );
  const validSubjects = new Set(subjectRows.map((row) => row.slug));
  const currentRows = await postgresClient.query<{ id: string }>(
    'SELECT id FROM subject_memory.current_items()'
  );
  const currentItems = new Set(currentRows.map((row) => row.id));

  const episodes = root.episodes.map((value, index): ElephantEpisode => {
    const row = asRecord(value, `episodes[${index}]`);
    exactKeys(
      row,
      [
        'id',
        'ts',
        'conversation_id',
        'source',
        'text',
        'keys',
        'sentiment',
        'refs',
      ],
      `episodes[${index}]`
    );
    const source = boundedString(row.source, 'episode source', 32) as string;
    const ts = Number(row.ts);
    const id = boundedString(row.id, 'episode id', 80) as string;
    if (!Number.isSafeInteger(ts) || ts < 1_000_000_000_000)
      throw new Error('episode ts must be epoch milliseconds');
    if (!SOURCES.has(source))
      throw new Error(`unsupported episode source ${source}`);
    validateId(id, ts, source);
    const keys = stringArray(row.keys, 'episode keys');
    if (keys.some((key) => !validSubjects.has(key)))
      throw new Error('episode contains an unknown subject slug');
    const sentiment =
      row.sentiment === null
        ? null
        : (boundedString(row.sentiment, 'episode sentiment', 32) as string);
    if (sentiment && !SENTIMENTS.has(sentiment))
      throw new Error(`unsupported sentiment ${sentiment}`);
    return {
      id,
      ts,
      conversation_id:
        row.conversation_id === null
          ? null
          : (boundedString(
              row.conversation_id,
              'conversation id',
              200
            ) as string),
      source,
      text: boundedString(row.text, 'episode text', 4_000) as string,
      keys,
      sentiment,
      refs: stringArray(row.refs, 'episode refs', 10),
    };
  });

  const items = root.items.map((value, index): ElephantItem => {
    const row = asRecord(value, `items[${index}]`);
    exactKeys(
      row,
      [
        'id',
        'ptype',
        'text',
        'why',
        'scope',
        'ts',
        'supersedes',
        'always_on',
        'origin',
      ],
      `items[${index}]`
    );
    if (row.origin !== 'user_stated')
      throw new Error('elephant items require origin=user_stated');
    const ts = Number(row.ts);
    const id = boundedString(row.id, 'item id', 80) as string;
    if (!Number.isSafeInteger(ts) || ts < 1_000_000_000_000)
      throw new Error('item ts must be epoch milliseconds');
    validateId(id, ts, 'user');
    const ptype = boundedString(row.ptype, 'item ptype', 32) as string;
    if (!ITEM_TYPES.has(ptype))
      throw new Error(`unsupported item ptype ${ptype}`);
    const scope = stringArray(row.scope, 'item scope');
    if (!scope.length || scope.some((key) => !validSubjects.has(key)))
      throw new Error('item scope contains an unknown subject slug');
    const supersedes =
      row.supersedes === null
        ? null
        : (boundedString(row.supersedes, 'supersedes', 80) as string);
    if (supersedes && !currentItems.has(supersedes))
      throw new Error('supersedes must identify an existing current item');
    if (typeof row.always_on !== 'boolean')
      throw new Error('always_on must be boolean');
    return {
      id,
      ptype,
      text: boundedString(row.text, 'item text', 2_000) as string,
      why:
        row.why === null
          ? null
          : (boundedString(row.why, 'item why', 1_000) as string),
      scope,
      ts,
      supersedes,
      always_on: row.always_on,
    };
  });

  const ids = [...episodes.map((row) => row.id), ...items.map((row) => row.id)];
  if (new Set(ids).size !== ids.length)
    throw new Error('ids must be unique within an append');
  if (ids.length) {
    const existing = await postgresClient.query<{ id: string }>(`
      SELECT id FROM subject_memory.episodes WHERE id = ANY($1::text[])
      UNION ALL
      SELECT id FROM subject_memory.items WHERE id = ANY($1::text[])`, [ids]);
    if (existing.length) throw new Error('append ids must not already exist');
  }

  const episodeIds = new Set(episodes.map((row) => row.id));
  const itemIds = new Set(items.map((row) => row.id));
  const evidence = root.evidence.map((value, index): ElephantEvidence => {
    const row = asRecord(value, `evidence[${index}]`);
    exactKeys(row, ['item_id', 'episode_id', 'role'], `evidence[${index}]`);
    const itemId = boundedString(row.item_id, 'evidence item_id', 80) as string;
    const episodeId = boundedString(
      row.episode_id,
      'evidence episode_id',
      80
    ) as string;
    const role = boundedString(row.role, 'evidence role', 32) as string;
    if (!itemIds.has(itemId) || !episodeIds.has(episodeId))
      throw new Error('evidence must link rows in the same append');
    if (!EVIDENCE_ROLES.has(role))
      throw new Error(`unsupported evidence role ${role}`);
    return { item_id: itemId, episode_id: episodeId, role };
  });
  for (const item of items) {
    const links = evidence.filter(link => link.item_id === item.id);
    if (!links.length) throw new Error('every item requires evidence in the same append');
    if (links.some(link => episodes.find(episode => episode.id === link.episode_id)?.source !== 'user')) {
      throw new Error('user_stated items require evidence from a user episode');
    }
  }

  return { episodes, items, evidence };
}

/** Validate the model's data-only response and append it with parameterized SQL. */
export async function appendV7ElephantOutput(response: string): Promise<void> {
  try {
    const write = await validateWrite(parseOutput(response));
    await postgresClient.transaction(async (client) => {
      for (const row of write.episodes) {
        await client.query(
          `
          INSERT INTO subject_memory.episodes
            (id, ts, conversation_id, source, text, keys, sentiment, refs, worker)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'v7-elephant')
          ON CONFLICT (id) DO NOTHING`,
          [
            row.id,
            row.ts,
            row.conversation_id,
            row.source,
            row.text,
            row.keys,
            row.sentiment,
            row.refs,
          ]
        );
      }
      for (const row of write.items) {
        await client.query(
          `
          INSERT INTO subject_memory.items
            (id, kind, ptype, text, why, scope, origin, ts, supersedes, always_on, worker)
          VALUES ($1, 'policy', $2, $3, $4, $5, 'user_stated', $6, $7, $8, 'v7-elephant')
          ON CONFLICT (id) DO NOTHING`,
          [
            row.id,
            row.ptype,
            row.text,
            row.why,
            row.scope,
            row.ts,
            row.supersedes,
            row.always_on,
          ]
        );
      }
      for (const row of write.evidence) {
        await client.query(
          `
          INSERT INTO subject_memory.evidence (item_id, episode_id, role)
          VALUES ($1, $2, $3)
          ON CONFLICT (item_id, episode_id) DO NOTHING`,
          [row.item_id, row.episode_id, row.role]
        );
      }
    });
  } catch (error) {
    console.warn(
      '[V7Elephant] Rejected model output:',
      error instanceof Error ? error.message : error
    );
  }
}
