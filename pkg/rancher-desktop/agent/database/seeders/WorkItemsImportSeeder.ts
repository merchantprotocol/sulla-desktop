/**
 * WorkItemsImportSeeder
 *
 * One-time import of the local install's markdown ledger
 * (`~/sulla/ledger/goals/*.md`) into the work-items tables
 * (migration 0044). SCHEMA-ONLY rule: this seeder never ships
 * hardcoded user data. It reads whatever is on THIS install at
 * boot and upserts by stable slug (`goal-<file>` / `epic-<file>-<n>` /
 * `task-<file>-<n>-<m>`). Safe to re-run — existing rows are
 * refreshed, never duplicated.
 *
 * Filesystem PROJECT.md folders under ~/sulla/projects/ stay as
 * PRDs (ProjectRegistry). This seeder only imports the ledger.
 */

import fs from 'node:fs';
import path from 'node:path';

import { WorkItemsModel } from '../models/WorkItemsModel';
import { resolveSullaLedgerDir } from '../../utils/sullaPaths';

interface ParsedTask {
  title:       string;
  description: string;
  status:      string;
  position:    number;
}

interface ParsedEpic {
  title:       string;
  description: string;
  status:      string;
  position:    number;
  tasks:       ParsedTask[];
}

interface ParsedGoal {
  slug:        string;
  title:       string;
  description: string;
  status:      string;
  priority:    string;
  sourcePath:  string;
  epics:       ParsedEpic[];
}

const SKIP_FILES = new Set(['README.md']);

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'item';
}

function mapStatus(raw: string): string {
  const s = raw.toLowerCase();
  if (/done|shipped|complete|closed|retired|superseded/.test(s)) return 'done';
  if (/blocked|gate|waiting/.test(s)) return 'blocked';
  if (/park|hold|tabled/.test(s)) return 'parked';
  if (/should|want|might|backlog/.test(s)) return 'backlog';
  if (/working|wip|active|in.?progress/.test(s)) return 'in_progress';
  return 'todo';
}

function mapPriority(raw: string): string {
  const s = raw.toLowerCase();
  if (/p0|critical/.test(s)) return 'critical';
  if (/p1|high/.test(s)) return 'high';
  if (/p3|p4|low/.test(s)) return 'low';
  return 'medium';
}

function checkboxStatus(mark: string): string {
  const m = mark.trim().toLowerCase();
  if (m === 'x') return 'done';
  if (m === '~' || m === '-') return 'in_progress';
  return 'todo';
}

function parseGoalFile(filePath: string, slug: string): ParsedGoal | null {
  let text: string;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  if (!text.trim()) return null;

  const lines = text.split('\n');
  let title = slug;
  let status = 'todo';
  let priority = 'medium';
  const descParts: string[] = [];
  const epics: ParsedEpic[] = [];
  let currentEpic: ParsedEpic | null = null;
  let inEpics = false;
  let inWhy = false;

  for (const line of lines) {
    const h1 = line.match(/^#\s+(?:Goal:\s*)?(.+?)\s*$/);
    if (h1 && title === slug) {
      title = h1[1].trim();
      continue;
    }

    const meta = line.match(/^\*\*([^*]+):\*\*\s*(.+?)\s*$/);
    if (meta) {
      const key = meta[1].trim().toLowerCase();
      const val = meta[2].trim();
      if (key === 'status') status = mapStatus(val);
      else if (key === 'priority') priority = mapPriority(val);
      else if (key === 'outcome metric' || key === 'metric') descParts.push(val);
      continue;
    }

    if (/^##\s+Epics\b/i.test(line)) {
      inEpics = true;
      inWhy = false;
      continue;
    }
    if (/^##\s+Why\b/i.test(line)) {
      inWhy = true;
      inEpics = false;
      continue;
    }
    if (/^##\s+/.test(line)) {
      inWhy = false;
      // stay in epics only for ## Epics; other H2s end both
      if (!/^##\s+Epics\b/i.test(line)) inEpics = false;
      continue;
    }

    if (inWhy && line.trim() && !line.startsWith('#')) {
      descParts.push(line.trim());
    }

    const epicHead = line.match(/^###\s+Epic\s+(\d+)\s*[—–-]\s*(.+?)\s*$/i)
      || line.match(/^###\s+(.+?)\s*$/);
    if (inEpics && epicHead) {
      if (currentEpic) epics.push(currentEpic);
      const rawTitle = (epicHead[2] || epicHead[1]).trim();
      currentEpic = {
        title:       rawTitle.replace(/\s*[✅⏳].*$/, '').trim(),
        description: '',
        status:      /✅/.test(rawTitle) && !/⏳/.test(rawTitle) ? 'done' : 'todo',
        position:    epics.length,
        tasks:       [],
      };
      continue;
    }

    const box = line.match(/^\s*-\s*\[([ xX~-])\]\s+(.+?)\s*$/);
    if (currentEpic && box) {
      currentEpic.tasks.push({
        title:       box[2].trim(),
        description: '',
        status:      checkboxStatus(box[1]),
        position:    currentEpic.tasks.length,
      });
      continue;
    }

    if (currentEpic && line.trim() && !line.startsWith('#') && !line.startsWith('-')) {
      currentEpic.description = currentEpic.description
        ? `${currentEpic.description}\n${line.trim()}`
        : line.trim();
    }
  }
  if (currentEpic) epics.push(currentEpic);

  return {
    slug,
    title,
    description: descParts.join('\n').trim(),
    status,
    priority,
    sourcePath:  filePath,
    epics,
  };
}

async function importGoal(goal: ParsedGoal): Promise<{ projects: number; epics: number; tasks: number }> {
  const counts = { projects: 0, epics: 0, tasks: 0 };
  const projectSlug = `goal-${goal.slug}`;
  const project = await WorkItemsModel.upsertProject({
    slug:        projectSlug,
    title:       goal.title,
    description: goal.description,
    status:      goal.status,
    priority:    goal.priority,
    source:      'ledger_import',
    source_ref:  goal.sourcePath,
  });
  counts.projects = 1;

  for (const epic of goal.epics) {
    const epicSlug = `epic-${goal.slug}-${epic.position + 1}-${slugify(epic.title)}`;
    const epicRow = await WorkItemsModel.upsertEpic({
      project_id:  project.id,
      slug:        epicSlug,
      title:       epic.title,
      description: epic.description,
      status:      epic.status,
      priority:    goal.priority,
      position:    epic.position,
      source:      'ledger_import',
      source_ref:  `${goal.sourcePath}#epic-${epic.position + 1}`,
    });
    counts.epics += 1;

    for (const task of epic.tasks) {
      const taskSlug = `task-${goal.slug}-${epic.position + 1}-${task.position + 1}-${slugify(task.title)}`;
      await WorkItemsModel.upsertTask({
        epic_id:     epicRow.id,
        parent_id:   null,
        slug:        taskSlug,
        title:       task.title,
        description: task.description,
        status:      task.status,
        priority:    goal.priority,
        position:    task.position,
        source:      'ledger_import',
        source_ref:  `${goal.sourcePath}#task-${epic.position + 1}-${task.position + 1}`,
      });
      counts.tasks += 1;
    }
  }

  return counts;
}

async function initialize(): Promise<void> {
  console.log('[WorkItemsImportSeeder] Importing local ledger goals...');
  await WorkItemsModel.ensureTables();

  const goalsDir = path.join(resolveSullaLedgerDir(), 'goals');
  if (!fs.existsSync(goalsDir)) {
    console.log('[WorkItemsImportSeeder] No ledger/goals directory — nothing to import');
    return;
  }

  let files: string[];
  try {
    files = fs.readdirSync(goalsDir).filter(f => f.endsWith('.md') && !SKIP_FILES.has(f));
  } catch (err) {
    console.warn('[WorkItemsImportSeeder] Could not read ledger/goals:', err);
    return;
  }

  let projects = 0;
  let epics = 0;
  let tasks = 0;

  for (const file of files) {
    const slug = file.replace(/\.md$/i, '');
    const parsed = parseGoalFile(path.join(goalsDir, file), slug);
    if (!parsed) continue;
    try {
      const counts = await importGoal(parsed);
      projects += counts.projects;
      epics += counts.epics;
      tasks += counts.tasks;
    } catch (err) {
      console.warn(`[WorkItemsImportSeeder] Failed to import ${file}:`, err);
    }
  }

  console.log(`[WorkItemsImportSeeder] Imported ${projects} project(s), ${epics} epic(s), ${tasks} task(s) from ${files.length} goal file(s)`);
}

export { initialize };
