// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, onBeforeUnmount, reactive, ref, watch, type Ref } from 'vue';

import type { SuggestedUseCase, UseCaseSuggestionResponse } from '@pkg/shared/useCaseSuggestions';

import { UseCaseIntentDirective, UseCaseIntentFactory, type UseCaseIntent } from '../services/UseCaseIntent';
import { UseCaseSuggestionStrip, type StripKey } from '../services/UseCaseSuggestionStrip';

export interface UseCaseSuggestionDeps {
  draft:     Ref<string>;
  /** True while the slash / @ popover, voice, or anything else owns the keyboard. */
  blocked:   Ref<boolean>;
  query:     (text: string, limit: number) => Promise<UseCaseSuggestionResponse>;
  /** ≤640px viewports show the top 3, stacked. */
  isNarrow:  () => boolean;
  debounceMs?: number;
  minChars?:   number;
}

/**
 * Wires the strip state machine and the picked intent to the composer: debounced
 * queries (stale responses dropped, old results kept until new ones land), the
 * one-chip-per-message intent, and the hint state.
 */
export function useUseCaseSuggestions(deps: UseCaseSuggestionDeps) {
  const strip = reactive(new UseCaseSuggestionStrip()) as UseCaseSuggestionStrip;
  const intent = ref<UseCaseIntent | null>(null);
  const factory = new UseCaseIntentFactory();
  const directive = new UseCaseIntentDirective();
  const debounceMs = deps.debounceMs ?? 150;
  const minChars = deps.minChars ?? 3;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const open = computed(() => !intent.value && strip.isOpen(deps.draft.value, deps.blocked.value));

  function schedule(text: string): void {
    if (timer) clearTimeout(timer);
    const request = ++generation;
    if (intent.value || text.trim().length < minChars) {
      strip.receive([], 0);

      return;
    }
    timer = setTimeout(() => {
      const limit = deps.isNarrow() ? 3 : 5;
      deps.query(text, limit)
        .then((result) => {
          if (request === generation) strip.receive(Array.isArray(result?.items) ? result.items : [], limit, result?.ms ?? 0);
        })
        .catch(() => {
          if (request === generation) strip.receive([], 0);
        });
    }, debounceMs);
  }

  watch(deps.draft, (text) => {
    strip.draftChanged(text);
    schedule(text);
  });
  onBeforeUnmount(() => { if (timer) clearTimeout(timer) });

  function pick(item: SuggestedUseCase): void {
    strip.pick(item);
    intent.value = factory.create(item, deps.draft.value);
  }

  function removeIntent(): void {
    intent.value = null;
    schedule(deps.draft.value);
  }

  /** Returns true when the strip or chip consumed the key. */
  function onKeydown(e: KeyboardEvent, caretAtEnd: boolean): boolean {
    if (e.key === 'Backspace' && intent.value && !deps.draft.value) {
      e.preventDefault();
      removeIntent();

      return true;
    }
    const key: StripKey = { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, caretAtEnd };
    const result = strip.handleKey(key, deps.draft.value, deps.blocked.value || !!intent.value);
    if (result.kind === 'ignored') return false;
    e.preventDefault();
    if (result.kind === 'pick') intent.value = factory.create(result.item, deps.draft.value);

    return true;
  }

  /** Called after the message (with its chip) went out. */
  function reset(): void {
    intent.value = null;
    strip.clear();
    generation++;
    if (timer) clearTimeout(timer);
  }

  return { strip, intent, open, directive, pick, removeIntent, dismiss: () => strip.dismiss(deps.draft.value), onKeydown, reset };
}
