// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * useArtifactMentions — source for the `@` mention popover.
 *
 * Surfaces ONLY the artifacts the user actually has on this machine, in
 * either the Library (routines, skills, functions, recipes, integrations)
 * or My Work (workflows). Source files, memory ids, internal agent names,
 * and anything else from the engine are deliberately not referenceable —
 * customers must never see raw codebase nouns in their composer.
 *
 * The six IPC handlers are called once per app session (cached at module
 * scope) so a rapid `@`-then-typing sequence doesn't re-scan the filesystem
 * on every keystroke. Call `prefetch()` on composer mount so the first
 * `@` is already populated; call `invalidate()` after an install/publish
 * so a freshly-added artifact shows up in the popover without a reload.
 */

import { ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

import type { MentionTarget } from '../models/Command';

// ─── Raw shapes returned by the IPC handlers ─────────────────────

interface LibraryRoutineRow {
  slug:         string;
  name?:        string;
  description?: string;
}

interface LibrarySkillRow {
  slug:         string;
  name?:        string;
  description?: string;
}

interface LibraryFunctionRow {
  slug:         string;
  name?:        string;
  description?: string;
}

interface LibraryRecipeRow {
  slug:         string;
  name?:        string;
  description?: string;
}

interface LibraryIntegrationRow {
  slug:         string;
  name?:        string;
  description?: string;
}

interface WorkflowDbRow {
  id:           string;
  name?:        string;
  description?: string;
  status?:      string;
}


// ─── Shared cache (one instance per window, across component mounts) ──

/** Loads and caches the mentionable artifacts; shared via ArtifactMentionStore.shared(). */
export class ArtifactMentionStore {
  private static instance: ArtifactMentionStore | undefined;

  static shared(): ArtifactMentionStore {
    ArtifactMentionStore.instance ??= new ArtifactMentionStore();

    return ArtifactMentionStore.instance;
  }

  readonly items = ref<MentionTarget[]>([]);
  readonly loaded = ref(false);
  inflight: Promise<void> | null = null;
  private watchingDatabase = false;

  constructor(private readonly ipc: Pick<typeof ipcRenderer, 'invoke' | 'on'> = ipcRenderer) {}

  private async invokeSafe<T>(channel: string): Promise<T[]> {
    try {
      const result = await this.ipc.invoke(channel);
      return Array.isArray(result) ? (result as T[]) : [];
    } catch (err) {
      console.warn(`[useArtifactMentions] IPC ${ channel } failed:`, err);
      return [];
    }
  }

  private static toToken(kind: MentionTarget['kind'], slugOrId: string): string {
    return `@${ kind }:${ slugOrId }`;
  }

  private static labelFrom(row: { name?: string; slug?: string; id?: string; description?: string }): string {
    const name = row.name?.trim();
    const slug = row.slug?.trim() || row.id?.trim() || '';
    const desc = row.description?.trim();
    const primary = name && name.length > 0 ? name : slug;
    if (desc) return `${ primary } — ${ desc }`;
    return primary;
  }

  /**
   * Lists come back empty while the database is still starting. Reload once
   * main reports it reachable, after any load already in flight.
   */
  private reloadWhenDatabaseAvailable(): void {
    if (this.watchingDatabase) return;
    this.watchingDatabase = true;
    this.ipc.on('database:available', () => {
      void (this.inflight ?? Promise.resolve()).then(() => this.loadAll());
    });
  }

  loadAll(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.reloadWhenDatabaseAvailable();

    const toToken = ArtifactMentionStore.toToken;
    const labelFrom = ArtifactMentionStore.labelFrom;

    this.inflight = (async() => {
      const [routines, skills, functions, recipes, integrations, workflows] = await Promise.all([
        this.invokeSafe<LibraryRoutineRow>('routines-template-list'),
        this.invokeSafe<LibrarySkillRow>('library-list-skills'),
        this.invokeSafe<LibraryFunctionRow>('functions-list'),
        this.invokeSafe<LibraryRecipeRow>('library-list-recipes'),
        this.invokeSafe<LibraryIntegrationRow>('library-list-integrations'),
        this.invokeSafe<WorkflowDbRow>('workflow-db-list'),
      ]);

      const next: MentionTarget[] = [];

      for (const r of routines) {
        if (!r?.slug) continue;
        next.push({ token: toToken('routine', r.slug), label: labelFrom(r), kind: 'routine' });
      }
      for (const s of skills) {
        if (!s?.slug) continue;
        next.push({ token: toToken('skill', s.slug), label: labelFrom(s), kind: 'skill' });
      }
      for (const f of functions) {
        if (!f?.slug) continue;
        next.push({ token: toToken('function', f.slug), label: labelFrom(f), kind: 'function' });
      }
      for (const r of recipes) {
        if (!r?.slug) continue;
        next.push({ token: toToken('recipe', r.slug), label: labelFrom(r), kind: 'recipe' });
      }
      for (const i of integrations) {
        if (!i?.slug) continue;
        next.push({ token: toToken('integration', i.slug), label: labelFrom(i), kind: 'integration' });
      }
      for (const w of workflows) {
        if (!w?.id) continue;
        // Archived workflows are fair game — user might want to reference a
        // past job. Drafts with no name get labeled by id so they're still
        // findable.
        next.push({ token: toToken('workflow', w.id), label: labelFrom(w), kind: 'workflow' });
      }

      this.items.value = next;
      this.loaded.value = true;
    })().finally(() => { this.inflight = null; });

    return this.inflight;
  }
}

// ─── Public API ─────────────────────────────────────────────────

export function useArtifactMentions() {
  const store = ArtifactMentionStore.shared();
  const { items, loaded } = store;

  /** Kick off the first load eagerly. Safe to call many times. */
  function prefetch(): void {
    if (loaded.value || store.inflight) return;
    void store.loadAll();
  }

  /** Re-scan after the user installs/publishes something. */
  function invalidate(): void {
    loaded.value = false;
    store.inflight = null;
    void store.loadAll();
  }

  /**
   * Filter the cached artifact list by the user's query. The popover
   * calls this synchronously on every keystroke, so cheap substring
   * matching against the label + token is all we do. Empty query
   * returns everything (capped so the popover doesn't balloon).
   */
  function list(query: string): readonly MentionTarget[] {
    if (!loaded.value) {
      // First call — start the fetch; subsequent keystrokes will hit
      // the populated cache. Until then we render an empty popover
      // rather than a stale/fake list.
      prefetch();
      return [];
    }
    const q = query.trim().toLowerCase();
    const MAX = 80;
    if (!q) return items.value.slice(0, MAX);
    const matches = items.value.filter(m =>
      m.token.toLowerCase().includes(q) ||
      m.label.toLowerCase().includes(q),
    );
    return matches.slice(0, MAX);
  }

  return {
    list,
    prefetch,
    invalidate,
    loaded,
    items,
  };
}
