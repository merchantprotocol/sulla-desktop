/*
  Detects `/…` or `@…` tokens at the caret inside a textarea and drives
  the popover state. The caller wires a <textarea ref="…"> and hands us
  the ref; we attach listeners and talk to the controller.

  When the user accepts a choice, we replace the token in-place so the
  textarea value is clean for send().
*/

import { watch, type Ref } from 'vue';

import { defaultSlashCommands, type SlashCommand, type MentionTarget } from '../models/Command';
import { useChatController } from '../controller/useChatController';

const SLASH_RE   = /(?:^|\s)(\/\w*)$/;
const MENTION_RE = /(?:^|\s)(@\w*)$/;

export interface MentionSource {
  list(query: string): readonly MentionTarget[];
}

export function useCommandPopover(
  textareaRef: Ref<HTMLTextAreaElement | null>,
  mentionSource: MentionSource,
): void {
  const c = useChatController();

  function scan() {
    const el = textareaRef.value; if (!el) return;
    const value  = el.value;
    const caret  = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);

    const slash = before.match(SLASH_RE);
    if (slash) {
      const q = slash[1].slice(1).toLowerCase();
      const items = defaultSlashCommands.filter(s => s.name.slice(1).startsWith(q));
      c.showPopover('slash', q, items);
      return;
    }
    const at = before.match(MENTION_RE);
    if (at) {
      const q = at[1].slice(1).toLowerCase();
      const items = mentionSource.list(q);
      c.showPopover('mention', q, items);
      return;
    }
    c.hidePopover();
  }

  function onInput()  { scan(); }
  function onKeydown(e: KeyboardEvent) {
    const p = c.popover.value;
    if (!p.open) return;

    if (e.key === 'ArrowDown') { e.preventDefault(); c.movePopoverSelection(1); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); c.movePopoverSelection(-1); }
    if (e.key === 'Enter') {
      const item = p.items[p.selected];
      if (item) {
        e.preventDefault();
        insertSelection(item);
      }
    }
    if (e.key === 'Escape') { e.preventDefault(); c.hidePopover(); }
  }

  function insertSelection(item: SlashCommand | MentionTarget) {
    const el = textareaRef.value; if (!el) return;
    const value = el.value;
    const caret = el.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const after  = value.slice(caret);
    const tok    = 'name' in item ? item.name : item.token;
    const replaced = before.replace(
      'name' in item ? SLASH_RE : MENTION_RE,
      (m, grabbed) => m.slice(0, m.length - grabbed.length) + tok + ' ',
    );
    el.value = replaced + after;
    el.dispatchEvent(new Event('input'));  // let v-model sync
    c.hidePopover();
    el.focus();
  }

  watch(textareaRef, (el, old) => {
    if (old) {
      old.removeEventListener('input', onInput);
      old.removeEventListener('keydown', onKeydown);
    }
    if (el) {
      el.addEventListener('input', onInput);
      el.addEventListener('keydown', onKeydown);
    }
  }, { immediate: true });
}
