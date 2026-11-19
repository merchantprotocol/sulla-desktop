// SPDX-License-Identifier: GPL-2.0-or-later
// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// "Sulla" is a trademark. See TRADEMARK.md.

import { computed, defineAsyncComponent, defineComponent, h, inject, provide, ref, type Component } from 'vue';

/** Injection key the retry callback is provided under by every lazy screen wrapper. */
export const LAZY_SCREEN_RETRY_KEY = Symbol('lazy-screen-retry');

/** Loading placeholder only appears after this many ms, so fast loads never flash. */
const LAZY_SCREEN_DELAY_MS = 150;

type ScreenLoader = () => Promise<Component | { default: Component }>;

/** Empty pane shown only while a slow chunk is still loading (after the delay). */
const LazyScreenLoading = defineComponent({
  name:   'LazyScreenLoading',
  render: () => h('div', { class: 'flex-1 min-h-0 overflow-hidden', 'aria-busy': 'true' }),
});

/** Shown when a chunk fails to load; Retry re-runs the loader instead of leaving a blank tab. */
const LazyScreenError = defineComponent({
  name:  'LazyScreenError',
  props: { error: { default: null } },
  setup() {
    const retry = inject<() => void>(LAZY_SCREEN_RETRY_KEY, () => undefined);
    return () => h(
      'div',
      { class: 'flex h-full w-full flex-col items-center justify-center gap-3 p-6 text-sm text-muted-token', role: 'alert' },
      [
        h('span', 'This screen failed to load.'),
        h('button', { type: 'button', class: 'rounded border border-border-token px-3 py-1', onClick: () => retry() }, 'Retry'),
      ],
    );
  },
});

/**
 * Wraps a dynamic `import()` of a screen so its code is fetched on first render only.
 * Each Retry builds a fresh async component so the loader runs again.
 */
export function lazyScreen(loader: ScreenLoader, name: string): Component {
  return defineComponent({
    name:          `Lazy${ name }`,
    inheritAttrs:  false,
    setup(_props, { attrs, slots }) {
      const attempt = ref(0);
      provide(LAZY_SCREEN_RETRY_KEY, () => {
        attempt.value += 1;
      });

      const screen = computed(() => {
        // Reading attempt makes the computed rebuild the async component on Retry.
        void attempt.value;
        return defineAsyncComponent({
          loader,
          delay:            LAZY_SCREEN_DELAY_MS,
          loadingComponent: LazyScreenLoading,
          errorComponent:   LazyScreenError,
        });
      });

      return () => h(screen.value, attrs, slots);
    },
  });
}
