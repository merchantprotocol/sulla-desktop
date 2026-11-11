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
 * one-chip-per-message intent, and the hint state. Construct it inside a
 * component's setup so its watcher and unmount hook bind to that component.
 */
export class UseCaseSuggestionBinding {
  readonly strip = reactive(new UseCaseSuggestionStrip()) as UseCaseSuggestionStrip;
  readonly intent = ref<UseCaseIntent | null>(null);
  readonly directive = new UseCaseIntentDirective();
  readonly open = computed(() => !this.intent.value && this.strip.isOpen(this.deps.draft.value, this.deps.blocked.value));
  private readonly factory = new UseCaseIntentFactory();
  private readonly debounceMs: number;
  private readonly minChars: number;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor(private readonly deps: UseCaseSuggestionDeps) {
    this.debounceMs = deps.debounceMs ?? 150;
    this.minChars = deps.minChars ?? 3;
    watch(deps.draft, (text) => {
      this.strip.draftChanged(text);
      this.schedule(text);
    });
    onBeforeUnmount(() => { if (this.timer) clearTimeout(this.timer) });
  }

  private schedule(text: string): void {
    if (this.timer) clearTimeout(this.timer);
    const request = ++this.generation;
    if (this.intent.value || text.trim().length < this.minChars) {
      this.strip.receive([], 0);

      return;
    }
    this.timer = setTimeout(() => {
      const limit = this.deps.isNarrow() ? 3 : 5;
      this.deps.query(text, limit)
        .then((result) => {
          if (request === this.generation) this.strip.receive(Array.isArray(result?.items) ? result.items : [], limit, result?.ms ?? 0);
        })
        .catch(() => {
          if (request === this.generation) this.strip.receive([], 0);
        });
    }, this.debounceMs);
  }

  pick(item: SuggestedUseCase): void {
    this.strip.pick(item);
    this.intent.value = this.factory.create(item, this.deps.draft.value);
  }

  removeIntent(): void {
    this.intent.value = null;
    this.schedule(this.deps.draft.value);
  }

  dismiss(): void {
    this.strip.dismiss(this.deps.draft.value);
  }

  /** Returns true when the strip or chip consumed the key. */
  onKeydown(e: KeyboardEvent, caretAtEnd: boolean): boolean {
    if (e.key === 'Backspace' && this.intent.value && !this.deps.draft.value) {
      e.preventDefault();
      this.removeIntent();

      return true;
    }
    const key: StripKey = { key: e.key, meta: e.metaKey, ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey, caretAtEnd };
    const result = this.strip.handleKey(key, this.deps.draft.value, this.deps.blocked.value || !!this.intent.value);
    if (result.kind === 'ignored') return false;
    e.preventDefault();
    if (result.kind === 'pick') this.intent.value = this.factory.create(result.item, this.deps.draft.value);

    return true;
  }

  /** Called after the message (with its chip) went out. */
  reset(): void {
    this.intent.value = null;
    this.strip.clear();
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
  }
}

/** Composable surface for the composer: the binding's state and bound actions. */
export function useUseCaseSuggestions(deps: UseCaseSuggestionDeps) {
  const binding = new UseCaseSuggestionBinding(deps);

  return {
    strip:        binding.strip,
    intent:       binding.intent,
    open:         binding.open,
    directive:    binding.directive,
    pick:         (item: SuggestedUseCase) => binding.pick(item),
    removeIntent: () => binding.removeIntent(),
    dismiss:      () => binding.dismiss(),
    onKeydown:    (e: KeyboardEvent, caretAtEnd: boolean) => binding.onKeydown(e, caretAtEnd),
    reset:        () => binding.reset(),
  };
}
