// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/**
 * The instructions Sulla reads before every conversation, stored as editable
 * sections (soul, user, heartbeat…), plus the queue of AI-proposed edits that
 * wait for the user's approval. Uses the `system-prompt:*` IPC.
 */
import { computed, onMounted, ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface PromptSection {
  id:            string;
  title:         string;
  content:       string;
  priority:      number;
  enabled:       boolean;
  is_builtin:    boolean;
  is_generated:  boolean;
  is_customized: boolean;
}

export interface PromptEdit {
  id:               string;
  section_id:       string;
  proposed_content: string;
  base_content:     string;
  rationale:        string | null;
  proposed_by:      string | null;
  created_at:       string;
}

export interface DiffLine { type: 'ctx' | 'add' | 'del'; text: string }

/** Line diffs between a prompt section's base and proposed text. */
export class PromptDiff {
  /** Line diff (base → proposed). Prompts are a few hundred lines at most. */
  static lines(base: string, proposed: string): DiffLine[] {
    const a = String(base || '').split('\n');
    const b = String(proposed || '').split('\n');
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));

    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const out: DiffLine[] = [];
    let i = 0;
    let j = 0;

    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        out.push({ type: 'ctx', text: a[i++] });
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        out.push({ type: 'del', text: a[i++] });
      } else {
        out.push({ type: 'add', text: b[j++] });
      }
    }
    while (i < a.length) {
      out.push({ type: 'del', text: a[i++] });
    }
    while (j < b.length) {
      out.push({ type: 'add', text: b[j++] });
    }

    return out;
  }
}

/** @deprecated use PromptDiff.lines */
export const diffLines = (base: string, proposed: string): DiffLine[] => PromptDiff.lines(base, proposed);

/** The slice of the renderer IPC the controller needs (swappable in tests). */
export interface PromptSectionsIpc {
  invoke(channel: string, ...args: any[]): Promise<any>;
}

/** Loads, edits and reviews Sulla's instruction sections over the `system-prompt:*` IPC. */
export class PromptSectionsController {
  readonly sections = ref<PromptSection[]>([]);
  readonly edits = ref<PromptEdit[]>([]);
  readonly loading = ref(true);
  readonly error = ref('');
  readonly sorted = computed(() => [...this.sections.value].sort((a, b) => a.priority - b.priority));

  constructor(private readonly ipc: PromptSectionsIpc) {}

  private message(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  load = async(): Promise<void> => {
    try {
      const [list, pending] = await Promise.all([
        this.ipc.invoke('system-prompt:list'),
        this.ipc.invoke('system-prompt-edits:list-pending'),
      ]);

      this.sections.value = (list || []) as PromptSection[];
      this.edits.value = (pending || []) as PromptEdit[];
      this.error.value = '';
    } catch (err) {
      this.error.value = `Could not load Sulla’s instructions: ${ this.message(err) }`;
    } finally {
      this.loading.value = false;
    }
  };

  find = (id: string): PromptSection | undefined => {
    return this.sections.value.find(s => s.id === id);
  };

  private replace(updated: PromptSection | null | undefined): void {
    if (!updated) {
      return;
    }
    const index = this.sections.value.findIndex(s => s.id === updated.id);

    if (index === -1) {
      this.sections.value.push(updated);
    } else {
      this.sections.value.splice(index, 1, updated);
    }
  }

  save = async(id: string, content: string): Promise<void> => {
    try {
      const updated = await this.ipc.invoke('system-prompt:update', id, { content }) as PromptSection | null;

      if (!updated) {
        // The section was deleted elsewhere: say so instead of looking saved.
        await this.load();
        this.error.value = 'Could not save: this section no longer exists.';

        return;
      }
      this.replace(updated);
      this.error.value = '';
    } catch (err) {
      this.error.value = `Could not save: ${ this.message(err) }`;
    }
  };

  setEnabled = async(section: PromptSection, enabled: boolean): Promise<void> => {
    try {
      const updated = await this.ipc.invoke('system-prompt:update', section.id, { enabled }) as PromptSection | null;

      if (!updated) {
        await this.load();
        this.error.value = 'Could not change this section: it no longer exists.';

        return;
      }
      this.replace(updated);
    } catch (err) {
      this.error.value = `Could not change this section: ${ this.message(err) }`;
    }
  };

  reset = async(id: string): Promise<void> => {
    try {
      this.replace(await this.ipc.invoke('system-prompt:reset', id) as PromptSection | null);
    } catch (err) {
      this.error.value = `Could not reset: ${ this.message(err) }`;
    }
  };

  add = async(title: string): Promise<string | undefined> => {
    const id = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    if (!id) {
      return undefined;
    }
    try {
      const input = { id, title, priority: 100 };
      const created = await this.ipc.invoke('system-prompt:add', input) as PromptSection | null;

      await this.load();

      return created?.id;
    } catch (err) {
      this.error.value = 'Could not add that section. Its name may already be taken.';

      return undefined;
    }
  };

  remove = async(section: PromptSection): Promise<void> => {
    if (section.is_builtin) {
      return;
    }
    try {
      await this.ipc.invoke('system-prompt:remove', section.id);
      await this.load();
    } catch (err) {
      this.error.value = `Could not delete: ${ this.message(err) }`;
    }
  };

  preview = async(id: string): Promise<string> => {
    try {
      return await this.ipc.invoke('system-prompt:preview-generated', id) || '';
    } catch {
      return '';
    }
  };

  approve = async(edit: PromptEdit, finalContent?: string): Promise<void> => {
    try {
      await this.ipc.invoke('system-prompt-edits:approve', edit.id, finalContent);
      await this.load();
    } catch (err) {
      this.error.value = `Could not approve this change: ${ this.message(err) }`;
    }
  };

  deny = async(edit: PromptEdit): Promise<void> => {
    try {
      await this.ipc.invoke('system-prompt-edits:deny', edit.id);
      await this.load();
    } catch (err) {
      this.error.value = `Could not decline this change: ${ this.message(err) }`;
    }
  };
}

/** Vue entry point: Sulla's instruction sections, loaded when the component mounts. */
export function usePromptSections() {
  const controller = new PromptSectionsController(ipcRenderer as unknown as PromptSectionsIpc);
  const {
    sections, sorted, edits, loading, error, load, find, save, setEnabled, reset, add, remove, preview, approve, deny,
  } = controller;

  onMounted(load);

  return {
    sections, sorted, edits, loading, error, load, find, save, setEnabled, reset, add, remove, preview, approve, deny,
  };
}
