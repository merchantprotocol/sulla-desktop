/**
 * useReflexIntent — live intent for the composer.
 *
 * As the human types, ask the main process (reflex:preview) what Reflex
 * would do if the draft were sent right now. When it would act, the
 * composer shows a one-key chip ("⚡ Open Projects ⇥"); Tab runs it
 * locally through reflex:run, no model turn. Enter still sends as usual.
 *
 * Previews are debounced and sequence-guarded so a slow reply for an old
 * draft never overwrites a newer one.
 */

import { ref, watch, type Ref } from 'vue';

import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export interface ReflexIntentPreview {
  toolName:   string;
  params:     Record<string, unknown>;
  confidence: number;
  label:      string;
}

export type ReflexIntentFlash = { kind: 'done' | 'error'; text: string } | null;

const DEBOUNCE_MS = 120;
const MIN_CHARS = 3;
const MAX_CHARS = 300;
const DONE_FLASH_MS = 1800;
const ERROR_FLASH_MS = 3500;

/** Drafts that are commands/mentions/multi-paragraph prose are never previewed. */
export function isPreviewableDraft(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_CHARS || t.length > MAX_CHARS) return false;
  if (t.startsWith('/') || t.startsWith('@') || t.startsWith('>')) return false;
  return !t.includes('\n');
}

export function useReflexIntent(draft: Ref<string>, enabled: Ref<boolean>) {
  const preview = ref<ReflexIntentPreview | null>(null);
  const flash = ref<ReflexIntentFlash>(null);
  const running = ref(false);
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  /** Draft text the human dismissed with Escape — stays hidden until the text changes. */
  let dismissedFor: string | null = null;

  function clearTimer(): void {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  function showFlash(next: ReflexIntentFlash, ms: number): void {
    if (flashTimer) clearTimeout(flashTimer);
    flash.value = next;
    flashTimer = setTimeout(() => { flash.value = null }, ms);
  }

  watch([draft, enabled], ([text, on]) => {
    clearTimer();
    const mine = ++seq;
    if (!on || !isPreviewableDraft(text) || text === dismissedFor) {
      preview.value = null;
      return;
    }
    timer = setTimeout(async() => {
      try {
        const result = await ipcRenderer.invoke('reflex:preview' as any, text.trim()) as ReflexIntentPreview | null;
        if (mine === seq) preview.value = result ?? null;
      } catch {
        if (mine === seq) preview.value = null;
      }
    }, DEBOUNCE_MS);
  });

  /** Run the suggested action. Returns true when it ran (the caller clears the draft). */
  async function accept(): Promise<boolean> {
    const current = preview.value;
    const text = draft.value.trim();
    if (!current || running.value || !text) return false;
    running.value = true;
    preview.value = null;
    try {
      const res = await ipcRenderer.invoke('reflex:run' as any, text) as { ok: boolean; label?: string; error?: string };
      if (res?.ok) {
        showFlash({ kind: 'done', text: res.label || current.label }, DONE_FLASH_MS);
        return true;
      }
      showFlash({ kind: 'error', text: res?.error || 'Reflex could not run that' }, ERROR_FLASH_MS);
      return false;
    } catch (err) {
      showFlash({ kind: 'error', text: err instanceof Error ? err.message : String(err) }, ERROR_FLASH_MS);
      return false;
    } finally {
      running.value = false;
    }
  }

  function dismiss(): void {
    dismissedFor = draft.value;
    preview.value = null;
  }

  function dispose(): void {
    clearTimer();
    if (flashTimer) clearTimeout(flashTimer);
  }

  return { preview, flash, running, accept, dismiss, dispose };
}
