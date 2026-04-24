/*
  Keep a scroller's bottom padding in sync with a variable-height
  composer so queued items / attachment tray / voice UI don't
  overlap the transcript.
*/

import { onBeforeUnmount, onMounted, type Ref } from 'vue';

export interface ResizeSyncOptions {
  /** Minimum padding even when composer is small. */
  min?: number;
  /** Buffer added on top of composer's measured height. */
  buffer?: number;
  /** Name of CSS variable to set. Default: --scroller-pad-b */
  cssVar?: string;
}

export function useResizeSync(
  targetRef:   Ref<HTMLElement | null>,
  composerRef: Ref<HTMLElement | null>,
  opts: ResizeSyncOptions = {},
): void {
  const min    = opts.min    ?? 180;
  const buffer = opts.buffer ?? 72;
  const cssVar = opts.cssVar ?? '--scroller-pad-b';

  let ro: ResizeObserver | null = null;

  const sync = () => {
    const t = targetRef.value; const c = composerRef.value;
    if (!t || !c) return;
    const pad = Math.max(min, c.offsetHeight + buffer);
    t.style.setProperty(cssVar, pad + 'px');
  };

  onMounted(() => {
    sync();
    if (typeof ResizeObserver !== 'undefined' && composerRef.value) {
      ro = new ResizeObserver(sync);
      ro.observe(composerRef.value);
    }
    window.addEventListener('resize', sync);
  });
  onBeforeUnmount(() => {
    ro?.disconnect();
    window.removeEventListener('resize', sync);
  });
}
