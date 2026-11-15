// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * Shelved-thread handoff notes: deterministic parts of /shelve and /resume.
 * Sulla writes the note body (a judgment task); everything here (command
 * parsing, slugs, frontmatter, ordering) is plain code.
 */

/** Folder under the Sulla Files Projects area; agents may write there. */
export const SHELF_FOLDER = 'Projects/Shelf';
export const SHELF_MOUNT_PATH = '/mnt/sulla-files/Projects/Shelf';

/** What the composer asks the shelf panel to do. */
export interface ShelfRequest { mode: 'shelve' | 'resume' | 'delete'; name?: string }

/** localStorage key a fresh resume tab reads once at mount: { prompt, agentId, fileId }. */
const RESUME_KEY = (tabId: string): string => `sulla:shelf-resume:${ tabId }`;

export type ShelfCommand =
  | { kind: 'shelve'; name?: string }
  | { kind: 'delete'; name: string }
  | { kind: 'resume'; name?: string };

/** "/shelve", "/shelve rc billing", "/shelve delete rc-billing", "/resume", "/resume rc-billing". */
function parseShelfCommand(text: string): ShelfCommand | null {
  const match = /^\/(shelve|resume)(?:\s+(.*))?$/i.exec(text.trim());
  if (!match) return null;
  const rest = (match[2] ?? '').trim();
  if (match[1].toLowerCase() === 'resume') return rest ? { kind: 'resume', name: rest } : { kind: 'resume' };
  const del = /^delete\s+(.+)$/i.exec(rest);
  if (del) return { kind: 'delete', name: del[1].trim() };
  return rest ? { kind: 'shelve', name: rest } : { kind: 'shelve' };
}

function slugify(name: string): string {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').slice(0, 60).replace(/^-|-$/g, '');
  return slug || 'thread';
}

/** A slug not already taken by an existing note: "rc-billing", "rc-billing-2", ... */
function uniqueSlug(name: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = slugify(name);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${ base }-${ n }`)) return `${ base }-${ n }`;
}

export interface ShelfMeta {
  name:             string;
  status:           'shelved' | 'resumed';
  shelvedAt:        string;
  chatThreadId:     string;
  backendThreadId?: string;
  tabTitle?:        string;
  tabId?:           string;
  agentId?:         string;
  resumedAt?:       string;
  resumedThreadId?: string;
}

export interface ShelfEntry {
  fileId: string;
  slug:   string;
  path:   string;
  meta:   ShelfMeta;
  /** First line of the "Goal" section, for the picker. */
  goal:   string;
}

const META_KEYS: (keyof ShelfMeta)[] = ['name', 'status', 'shelvedAt', 'chatThreadId', 'backendThreadId', 'tabTitle', 'tabId', 'agentId', 'resumedAt', 'resumedThreadId'];

function yamlValue(value: string): string {
  return /^[\w.:@/-]*$/.test(value) && value !== '' ? value : JSON.stringify(value);
}

function buildNote(meta: ShelfMeta, body: string): string {
  const lines = META_KEYS.filter(key => meta[key] !== undefined && meta[key] !== '').map(key => `${ key }: ${ yamlValue(String(meta[key])) }`);
  return `---\n${ lines.join('\n') }\n---\n\n${ body.trim() }\n`;
}

function parseNote(text: string): { meta: ShelfMeta; body: string } | null {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) { try { value = JSON.parse(value) } catch { /* keep raw */ } }
    meta[kv[1]] = value;
  }
  if (!meta.name || !meta.chatThreadId || !meta.status) return null;
  // Agents sometimes rewrite the status ("done", "closed"). Only "shelved" is still on the shelf;
  // anything else counts as resumed, so the note never vanishes from the picker.
  if (meta.status !== 'shelved') meta.status = 'resumed';
  return { meta: meta as unknown as ShelfMeta, body: match[2].trim() };
}

/** The first non-empty line under a "Goal" heading, else the first line of the body. */
function goalLine(body: string): string {
  const lines = body.split('\n');
  const at = lines.findIndex(line => /^#+\s*goal\b/i.test(line.trim()));
  const source = at >= 0 ? lines.slice(at + 1) : lines;
  const first = source.map(line => line.trim()).find(line => line && !line.startsWith('#')) ?? '';
  return first.replace(/^[-*]\s+/, '').slice(0, 160);
}

function markResumed(text: string, resumedThreadId: string, at: Date): string {
  const parsed = parseNote(text);
  if (!parsed) throw new Error('Not a shelf note');
  return buildNote({ ...parsed.meta, status: 'resumed', resumedAt: at.toISOString(), resumedThreadId }, parsed.body);
}

/** Newest first; resumed notes hidden unless asked for. */
function pickerEntries(entries: readonly ShelfEntry[], showResumed: boolean): ShelfEntry[] {
  return entries.filter(entry => showResumed || entry.meta.status === 'shelved')
    .slice().sort((a, b) => b.meta.shelvedAt.localeCompare(a.meta.shelvedAt));
}

/** Match "/resume <name>" or "/shelve delete <name>" against slug or display name. */
function findEntry(entries: readonly ShelfEntry[], name: string): ShelfEntry | undefined {
  const slug = slugify(name);
  return entries.find(entry => entry.slug === slug) ?? entries.find(entry => entry.meta.name.toLowerCase() === name.trim().toLowerCase());
}

/** The note body Sulla returns between <handoff> tags; the whole reply if it forgot the tags. */
function extractHandoff(reply: string): string {
  const tagged = /<handoff>([\s\S]*?)<\/handoff>/i.exec(reply);
  return (tagged ? tagged[1] : reply).trim();
}

function handoffRequest(name: string, stopSummary: string): string {
  return [
    `I'm shelving this thread as "${ name }" to pick it up later in a fresh thread. Write the handoff note now.`,
    '',
    stopSummary,
    '',
    'Reply with ONLY the note, in markdown, between <handoff> and </handoff>, using exactly these sections in order:',
    '## Goal',
    '## Decisions made (and who decided)',
    '## State (merged / open / failing, with PR numbers and commit SHAs)',
    '## What was running and what was done to it',
    '## Open questions for the user',
    '## Next 3 steps',
    '## Key files and links',
    'Do not start any new work, tools or agents.',
  ].join('\n');
}

function resumePrompt(entry: ShelfEntry): string {
  return `Resume the shelved work "${ entry.meta.name }". Read ${ SHELF_MOUNT_PATH }/${ entry.slug }.md, then check what changed since ${ entry.meta.shelvedAt } (PR states, CI, merges, anything the note says was in flight) and report that before you act. Then continue from the note's next steps. Do not edit the note's frontmatter (the --- block at the top); Sulla Desktop tracks its status. You may append an "## Outcome" section.`;
}

/** Shelf notes: /shelve and /resume commands, note files, and the handoff and resume prompts. */
export class ShelfNotes {
  static readonly parseShelfCommand = parseShelfCommand;
  static readonly slugify = slugify;
  static readonly uniqueSlug = uniqueSlug;
  static readonly buildNote = buildNote;
  static readonly parseNote = parseNote;
  static readonly goalLine = goalLine;
  static readonly markResumed = markResumed;
  static readonly pickerEntries = pickerEntries;
  static readonly findEntry = findEntry;
  static readonly extractHandoff = extractHandoff;
  static readonly handoffRequest = handoffRequest;
  static readonly resumePrompt = resumePrompt;
  static readonly RESUME_KEY = RESUME_KEY;
}
