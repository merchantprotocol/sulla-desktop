/**
 * System Prompt Section Defaults — the baked-in native fallbacks.
 *
 * This is the SINGLE canonical source for the shipped default content of every
 * editable identity/system-prompt row. It is used in two places:
 *   1. SystemPromptSectionModel.seedDefaults() — seeds a fresh DB (write-only-
 *      if-absent, never clobbering the human's edits), and
 *   2. "Reset to default" in the UI — restores a row to its shipped content.
 *
 * THREE-LAYER RESOLUTION (highest wins), see migration 0048:
 *   1. agent-specific physical file  (~/sulla/agents/<id>/*.md)
 *   2. DB row                        (sulla_system_prompt_sections)  ← seeded from here
 *   3. baked-in native fallback      (THIS FILE / the section factories)
 *
 * Because the section factories (soul.ts, environment.ts, heartbeat.ts, …) stay
 * intact, they remain the ultimate runtime fallback if the DB is empty/unreachable.
 * This module exists so the SEED and the RESET pull from one authoritative place.
 */
import fs from 'node:fs';
import path from 'node:path';

import { resolveSullaDocsDir } from '@pkg/agent/utils/sullaPaths';

import { heartbeatPrompt } from './heartbeat';
import { ENVIRONMENT_STATIC_PREAMBLE } from './sections/environment';
import { SOUL_CONTENT } from './sections/soul';

export type CacheStability = 'stable' | 'semi-stable' | 'dynamic';

export interface SystemPromptSectionDefault {
  /** Section id — matches a registered prompt-section id where one exists. */
  id:              string;
  /** Human-facing label shown in the System Prompt settings UI. */
  title:           string;
  /** Sort order in the compiled prompt (mirrors the registered section priority). */
  priority:        number;
  cacheStability:  CacheStability;
  /**
   * The body is (partly) produced at runtime — e.g. `environment` appends live
   * installed-extension/integration data. The stored content is the editable
   * STATIC preamble; the generated tail is shown read-only in the UI and
   * appended by the section factory at compile time.
   */
  isGenerated:     boolean;
  /** Whether the section is enabled (injected) by default on a fresh seed. */
  enabledByDefault: boolean;
  /** Resolve the baked default content. Async because some read bundled files. */
  resolveContent:  () => Promise<string> | string;
}

/**
 * Read a bundled sulla-docs markdown file. Best-effort: returns '' if the file
 * cannot be resolved so a packaging hiccup never blocks DB seeding.
 */
function readBundledDoc(...segments: string[]): string {
  try {
    const file = path.join(resolveSullaDocsDir(), ...segments);
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    console.warn('[SystemPromptSectionDefaults] could not read bundled doc', segments.join('/'), err);
    return '';
  }
}

/**
 * The canonical identity rows, seeded on first boot. Ordering here is display
 * order; `priority` governs compiled-prompt placement.
 *
 * `agents` ships DISABLED: it is reference documentation (not part of the
 * compiled prompt today), so enabling it injects a large doc into every prompt.
 * The human can opt it in from the UI.
 */
export const SYSTEM_PROMPT_SECTION_DEFAULTS: SystemPromptSectionDefault[] = [
  {
    id:               'user',
    title:            'User',
    priority:         15,
    cacheStability:   'stable',
    isGenerated:      false,
    enabledByDefault: true,
    // Seeded empty — freeform notes about the human. The name itself stays in
    // the botName / primaryUserName settings shown at the top of the panel.
    resolveContent:   () => '',
  },
  {
    id:               'soul',
    title:            'Soul',
    priority:         20,
    cacheStability:   'stable',
    isGenerated:      false,
    enabledByDefault: true,
    resolveContent:   () => SOUL_CONTENT,
  },
  {
    id:               'environment',
    title:            'Environment',
    priority:         50,
    cacheStability:   'stable',
    isGenerated:      true, // live installed-extensions / integrations tail appended at runtime
    enabledByDefault: true,
    resolveContent:   () => ENVIRONMENT_STATIC_PREAMBLE,
  },
  {
    id:               'agents',
    title:            'Agents',
    priority:         90,
    cacheStability:   'stable',
    isGenerated:      false,
    enabledByDefault: false, // reference doc — opt-in so it doesn't bloat every prompt
    resolveContent:   () => readBundledDoc('tools', 'agents.md'),
  },
  {
    id:               'heartbeat',
    title:            'Heartbeat',
    priority:         110,
    cacheStability:   'stable',
    isGenerated:      false,
    enabledByDefault: true,
    resolveContent:   () => heartbeatPrompt,
  },
];

/** Look up a single default by id. */
export function getSystemPromptSectionDefault(id: string): SystemPromptSectionDefault | undefined {
  return SYSTEM_PROMPT_SECTION_DEFAULTS.find(d => d.id === id);
}

/** The set of canonical (builtin) ids — used to guard delete/reset semantics. */
export const BUILTIN_SECTION_IDS = new Set(SYSTEM_PROMPT_SECTION_DEFAULTS.map(d => d.id));
