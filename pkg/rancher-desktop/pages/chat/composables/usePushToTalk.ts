/*
  usePushToTalk — hold Space to talk, release to send. Desktop's version of
  Sulla Mobile's PTT button.

    press Space ........ mic + whisper arm silently (ptt-arm)
    held ≥ 250ms ....... it's a real turn: Sulla stops talking, recording UI shows (ptt-activate)
    release ............ the whole hold is transcribed and sent as one voice message (ptt-end)
    quick tap .......... just a space — typed into the composer if it had focus (ptt-cancel)
    Esc / window blur .. cancel, nothing sent (ptt-cancel)

  Space only means "talk" where it can't mean anything else: an empty chat
  composer, or nowhere editable/clickable focused. With text in the composer, on
  a button, in a modal, or while hands-free listening is on, Space behaves
  normally. The VoiceSessionAdapter owns the audio; this only turns keys into
  commands on the active tab's controller.
*/

import { onBeforeUnmount, onMounted, watch, type Ref } from 'vue';

import type { VoiceCommand } from '../controller/events';

/** Hold at least this long before Space means "talk" (Sulla Mobile's default long-press). */
export const PTT_HOLD_MS = 250;

export interface PushToTalkDeps {
  /** Only the visible tab handles keys. */
  isActive:    () => boolean;
  /** Something else owns the keyboard right now (modal/popover open, hands-free listening). */
  isBlocked:   () => boolean;
  command:     (c: VoiceCommand) => void;
  setTimer?:   (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

export interface PushToTalk {
  onKeyDown(e: KeyboardEvent): void;
  onKeyUp(e: KeyboardEvent): void;
  /** Window lost focus mid-hold — keyup may never come. */
  cancel(): void;
  readonly holding: boolean;
}

const INTERACTIVE_SELECTOR = [
  'button', 'a[href]', 'select', 'summary', 'input', 'label',
  '[role="button"]', '[role="checkbox"]', '[role="switch"]', '[role="menuitem"]',
  '[role="tab"]', '[role="option"]', '[role="slider"]', '[role="textbox"]',
].join(',');

function isEditable(el: HTMLElement): boolean {
  const tag = el.tagName?.toLowerCase();

  return tag === 'textarea' || tag === 'input' || el.isContentEditable;
}

function editableText(el: HTMLElement): string {
  return (el as HTMLTextAreaElement).value ?? el.textContent ?? '';
}

/**
 * May Space start push-to-talk with focus on `target`? Yes on the empty chat
 * composer or on nothing interactive; never where Space types or clicks.
 */
export function spaceMeansTalk(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;

  if (!el || !el.tagName || el === document.body || el === document.documentElement) return true;
  if (isEditable(el)) {
    return !!el.closest('.composer') && editableText(el).trim() === '';
  }

  return !el.closest(INTERACTIVE_SELECTOR);
}

export function createPushToTalk(deps: PushToTalkDeps): PushToTalk {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));

  let holding = false;
  let activated = false;
  let timer: unknown = null;
  let pressTarget: HTMLElement | null = null;

  function reset(): void {
    if (timer !== null) clearTimer(timer);
    timer = null;
    holding = false;
    activated = false;
    pressTarget = null;
  }

  function cancel(): void {
    if (!holding) return;
    reset();
    deps.command('ptt-cancel');
  }

  return {
    get holding() {
      return holding;
    },

    onKeyDown(e: KeyboardEvent): void {
      if (holding) {
        if (e.code === 'Space') {
          e.preventDefault(); // auto-repeat while held
        } else if (e.key === 'Escape') {
          e.preventDefault();
          e.stopImmediatePropagation(); // Esc means "cancel this hold", not "stop the run"
          cancel();
        }

        return;
      }
      if (e.code !== 'Space' || e.repeat || e.isComposing) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (!deps.isActive() || deps.isBlocked()) return;
      if (!spaceMeansTalk(e.target)) return;

      e.preventDefault();
      holding = true;
      activated = false;
      pressTarget = e.target as HTMLElement | null;
      deps.command('ptt-arm');
      timer = setTimer(() => {
        timer = null;
        if (!holding) return;
        activated = true;
        deps.command('ptt-activate');
      }, PTT_HOLD_MS);
    },

    onKeyUp(e: KeyboardEvent): void {
      if (!holding || e.code !== 'Space') return;
      e.preventDefault();
      const wasActivated = activated;
      const target = pressTarget;

      reset();
      if (wasActivated) {
        deps.command('ptt-end');

        return;
      }
      // A tap: not a turn. Give the space back if it was typed into the composer.
      deps.command('ptt-cancel');
      if (target && isEditable(target) && document.activeElement === target) {
        document.execCommand('insertText', false, ' ');
      }
    },

    cancel,
  };
}

/** Wire hold-Space push-to-talk for one chat tab. */
export function usePushToTalk(opts: {
  isActive:  Ref<boolean | undefined>;
  isBlocked: () => boolean;
  command:   (c: VoiceCommand) => void;
}): void {
  const ptt = createPushToTalk({
    isActive:  () => !!opts.isActive.value,
    isBlocked: opts.isBlocked,
    command:   opts.command,
  });
  const onBlur = () => ptt.cancel();
  const onVisibility = () => {
    if (document.hidden) ptt.cancel();
  };

  // Switching tabs mid-hold: the keyup will land on another tab — drop this hold.
  watch(opts.isActive, (active) => {
    if (!active) ptt.cancel();
  });

  onMounted(() => {
    // Capture phase so Esc during a hold is handled before the chat's own Esc shortcut.
    window.addEventListener('keydown', ptt.onKeyDown, true);
    window.addEventListener('keyup', ptt.onKeyUp, true);
    window.addEventListener('blur', onBlur);
    document.addEventListener('visibilitychange', onVisibility);
  });
  onBeforeUnmount(() => {
    ptt.cancel();
    window.removeEventListener('keydown', ptt.onKeyDown, true);
    window.removeEventListener('keyup', ptt.onKeyUp, true);
    window.removeEventListener('blur', onBlur);
    document.removeEventListener('visibilitychange', onVisibility);
  });
}
