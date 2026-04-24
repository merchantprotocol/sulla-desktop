/*
  Auto-scroll the transcript on new messages. Disables itself when
  the user has scrolled up; re-enables when they return to the bottom.
  Surfaces a `showPill` flag when scrolled up far enough that a
  "jump to newest" affordance should appear.
*/

import { ref, onMounted, onBeforeUnmount, watch, nextTick, type Ref } from 'vue';

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

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = scrollerRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  function onScroll() {
    const el = scrollerRef.value; if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    showPill.value = dist > 220;
  }

  function attach() {
    const el = scrollerRef.value; if (!el) return;
    const start = () => { userScrolling = true; };
    const end = () => {
      if (endScrollTimer) clearTimeout(endScrollTimer);
      endScrollTimer = setTimeout(() => { userScrolling = false; }, 150);
    };
    el.addEventListener('wheel',     start, { passive: true });
    el.addEventListener('wheel',     end,   { passive: true });
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchend',   end,   { passive: true });
    el.addEventListener('scroll',     onScroll, { passive: true });
  }

  onMounted(() => {
    attach();
    scrollToBottom();
  });

  watch(scrollerRef, (el) => { if (el) attach(); });

  // Auto-scroll on new message count changes unless the user is reading up.
  watch(() => itemsRef.value.length, async () => {
    await nextTick();
    const el = scrollerRef.value; if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (!userScrolling && dist < 400) scrollToBottom();
  }, { flush: 'post' });

  onBeforeUnmount(() => {
    if (endScrollTimer) clearTimeout(endScrollTimer);
  });

  return { showPill, scrollToBottom };
}
