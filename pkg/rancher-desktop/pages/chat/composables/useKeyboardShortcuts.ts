/*
  Global keyboard shortcuts for the chat. One file, one switch.
*/

import { onMounted, onBeforeUnmount } from 'vue';

import { useChatController } from '../controller/useChatController';
import type { ChatController } from '../controller/ChatController';

export interface KeyboardShortcutOptions {
  onVoiceToggle?: () => void;
  /** When called from the component that *provides* the controller,
   *  pass it in explicitly — Vue doesn't let a component inject its
   *  own provide. */
  controller?: ChatController;
}

export function useKeyboardShortcuts(opts: KeyboardShortcutOptions = {}): void {
  const c = opts.controller ?? useChatController();

  function handle(e: KeyboardEvent) {
    const metaish = e.metaKey || e.ctrlKey;
    const tag  = (e.target as HTMLElement | null)?.tagName?.toLowerCase();
    const inEditable = tag === 'input' || tag === 'textarea' || (e.target as HTMLElement | null)?.isContentEditable;

    // ⌘K — model switcher
    if (metaish && e.key.toLowerCase() === 'k') {
      e.preventDefault(); c.openModal('model'); return;
    }
    // ⌘F — search
    if (metaish && e.key.toLowerCase() === 'f') {
      e.preventDefault(); c.openModal('search'); return;
    }
    // ⌘N — new chat  (handled by parent registry; event here for later)
    // ⌘⇧H — toggle history rail
    if (metaish && e.shiftKey && e.key.toLowerCase() === 'h') {
      e.preventDefault(); c.toggleHistory(); return;
    }
    // ⌘/ — voice toggle
    if (metaish && e.key === '/') {
      e.preventDefault(); opts.onVoiceToggle?.(); return;
    }
    // Esc — close modals / popovers / stop run / cancel recording
    if (e.key === 'Escape') {
      if (c.modals.value.which)  { e.preventDefault(); c.closeModal(); return; }
      if (c.popover.value.open)  { e.preventDefault(); c.hidePopover(); return; }
      if (c.voice.value.phase === 'recording') { e.preventDefault(); opts.onVoiceToggle?.(); return; }
      if (c.isRunning.value)     { e.preventDefault(); c.stop(); return; }
    }
    // ? — shortcuts overlay, only when not typing somewhere
    if (e.key === '?' && !inEditable) {
      e.preventDefault(); c.openModal('shortcuts');
    }
  }

  onMounted(() => {
    document.addEventListener('keydown', handle);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('keydown', handle);
  });
}
