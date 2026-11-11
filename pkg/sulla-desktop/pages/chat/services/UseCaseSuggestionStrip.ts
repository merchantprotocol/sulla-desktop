// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { isSuggestableUseCaseType, type SuggestedUseCase } from '@pkg/shared/useCaseSuggestions';

export interface StripKey {
  key:        string;
  meta:       boolean;
  ctrl:       boolean;
  shift:      boolean;
  alt:        boolean;
  /** Caret sits at the end of the draft (no selection). */
  caretAtEnd: boolean;
}

export type StripKeyResult =
  | { kind: 'ignored' }
  | { kind: 'consumed' }
  | { kind: 'pick'; item: SuggestedUseCase };

/**
 * Keyboard / pick state machine for the composer's use-case strip (approved
 * mockup Projects/sulla-desktop/mockups/usecase-suggestions). Plain class: the
 * composer wraps it in reactive() and feeds it drafts, results and keys.
 *
 *  ↓ at end of draft highlights row 1, ↑↓ move, ⏎ picks the highlighted row
 *  (⏎ with nothing highlighted is ignored, so the message sends), ⌘/Ctrl 1–5
 *  pick directly, typing clears the highlight, Esc clears the highlight and a
 *  second Esc hides the strip until the topic words change. Tab is untouched.
 */
export class UseCaseSuggestionStrip {
  items: SuggestedUseCase[] = [];
  active = -1;
  dismissedTopic: string | null = null;
  latencyMs = 0;

  static topicOf(text: string): string {
    return (text.toLowerCase().match(/[a-z]{4,}/g) ?? []).slice(0, 4).join(' ');
  }

  /** Old results stay until new ones land; functions never get in. */
  receive(items: readonly SuggestedUseCase[], maxVisible: number, latencyMs = 0): void {
    this.items = items.filter(item => isSuggestableUseCaseType(item.type)).slice(0, Math.max(0, maxVisible));
    this.latencyMs = latencyMs;
    if (this.active >= this.items.length) this.active = -1;
  }

  draftChanged(text: string): void {
    this.active = -1;
    if (this.dismissedTopic !== null && this.dismissedTopic !== UseCaseSuggestionStrip.topicOf(text)) this.dismissedTopic = null;
  }

  isOpen(text: string, blocked: boolean): boolean {
    return !blocked && this.items.length > 0 && this.dismissedTopic !== UseCaseSuggestionStrip.topicOf(text);
  }

  dismiss(text: string): void {
    this.active = -1;
    this.dismissedTopic = UseCaseSuggestionStrip.topicOf(text);
  }

  clear(): void {
    this.items = [];
    this.active = -1;
    this.dismissedTopic = null;
  }

  activeItem(): SuggestedUseCase | undefined {
    return this.active >= 0 ? this.items[this.active] : undefined;
  }

  handleKey(key: StripKey, text: string, blocked: boolean): StripKeyResult {
    if (!this.isOpen(text, blocked)) return { kind: 'ignored' };

    if ((key.meta || key.ctrl) && !key.alt && /^[1-5]$/.test(key.key)) {
      const item = this.items[Number(key.key) - 1];

      return item ? this.pick(item) : { kind: 'consumed' };
    }
    if (key.meta || key.ctrl || key.alt) return { kind: 'ignored' };

    switch (key.key) {
    case 'ArrowDown':
      if (this.active < 0 && !key.caretAtEnd) return { kind: 'ignored' };
      this.active = Math.min(this.items.length - 1, this.active + 1);

      return { kind: 'consumed' };
    case 'ArrowUp':
      if (this.active < 0) return { kind: 'ignored' };
      this.active -= 1;

      return { kind: 'consumed' };
    case 'Escape':
      if (this.active >= 0) this.active = -1;
      else this.dismiss(text);

      return { kind: 'consumed' };
    case 'Enter': {
      if (key.shift) return { kind: 'ignored' };
      const item = this.activeItem();

      return item ? this.pick(item) : { kind: 'ignored' };
    }
    default:
      return { kind: 'ignored' };
    }
  }

  pick(item: SuggestedUseCase): StripKeyResult {
    this.active = -1;
    this.items = [];

    return { kind: 'pick', item };
  }
}
