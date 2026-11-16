// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/*
  Auto-scroll the transcript on new messages and while a reply streams in.
  "Pinned" means the reader is at the bottom: content growth (new messages,
  streaming text, cards expanding) keeps them there. Scrolling up unpins;
  returning to the bottom re-pins.

  Following is always an instant jump: the scroller has CSS smooth scrolling,
  and an animated follow fired on every streamed chunk left the view
  mid-animation, which read as "the user scrolled up" and then raced back
  down. Only a real user gesture can unpin.
  Surfaces a `showPill` flag when scrolled up far enough that a
  "jump to newest" affordance should appear.
*/

import { ref, onMounted, onBeforeUnmount, watch, nextTick, type Ref } from 'vue';

/** Within this distance of the bottom counts as "at the bottom". */
const PIN_THRESHOLD_PX = 80;
/** A scroll this soon after wheel/touch/key/pointer input is the user's, not ours. */
const USER_GESTURE_MS = 800;

export interface ScrollAnchor {
  showPill: Ref<boolean>;
  scrollToBottom: () => void;
}

export function useScrollAnchor(
  scrollerRef: Ref<HTMLElement | null>,
  /** Something to watch for length changes to trigger auto-scroll. */
  itemsRef:  Ref<unknown[] | readonly unknown[]>,
): ScrollAnchor {
  const showPill = ref(false);
  let userScrolling = false;
  let endScrollTimer: ReturnType<typeof setTimeout> | null = null;
  // Starts pinned: a freshly opened chat shows the newest text.
  let pinned = true;
  let contentObserver: ResizeObserver | null = null;
  let lastGestureAt = 0;

  /** Jump without animation so following never leaves the view mid-scroll. */
  function follow(el: HTMLElement) {
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
  }

  /** "Jump to newest" and first open: the reader asked to be at the bottom. */
  function scrollToBottom() {
    pinned = true;
    requestAnimationFrame(() => {
      const el = scrollerRef.value;
      if (el) follow(el);
    });
  }

  function onScroll() {
    const el = scrollerRef.value; if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    showPill.value = dist > 220;
    if (dist <= PIN_THRESHOLD_PX) pinned = true;
    else if (performance.now() - lastGestureAt < USER_GESTURE_MS) pinned = false;
  }

  /** Streaming text grows an existing message without changing the count, so follow height instead. */
  function observeContent(el: HTMLElement) {
    contentObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined') return;
    contentObserver = new ResizeObserver(() => {
      if (pinned && !userScrolling) follow(el);
    });
    for (const child of Array.from(el.children)) contentObserver.observe(child);
  }

  function attach() {
    const el = scrollerRef.value; if (!el) return;
    const start = () => { userScrolling = true; lastGestureAt = performance.now(); };
    const gesture = () => { lastGestureAt = performance.now(); };
    const end = () => {
      if (endScrollTimer) clearTimeout(endScrollTimer);
      endScrollTimer = setTimeout(() => { userScrolling = false; }, 150);
    };
    el.addEventListener('wheel',     start, { passive: true });
    el.addEventListener('wheel',     end,   { passive: true });
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend',   end,   { passive: true });
    el.addEventListener('scroll',     onScroll, { passive: true });
    // Scrollbar drags and keyboard paging are user scrolls too.
    el.addEventListener('pointerdown', gesture, { passive: true });
    el.addEventListener('keydown',     gesture, { passive: true });
    observeContent(el);
  }

  onMounted(() => {
    attach();
    scrollToBottom();
  });

  watch(scrollerRef, (el) => { if (el) attach(); });

  // New messages follow the same rule as streaming text: only while pinned.
  watch(() => itemsRef.value.length, async () => {
    await nextTick();
    const el = scrollerRef.value; if (!el) return;
    if (pinned && !userScrolling) follow(el);
  }, { flush: 'post' });

  onBeforeUnmount(() => {
    if (endScrollTimer) clearTimeout(endScrollTimer);
    contentObserver?.disconnect();
  });

  return { showPill, scrollToBottom };
}
