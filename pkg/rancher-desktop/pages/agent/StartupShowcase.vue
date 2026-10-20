<template>
  <section
    v-if="painted"
    class="sulla-showcase"
    role="region"
    aria-roledescription="carousel"
    aria-label="What Sulla can do"
    tabindex="0"
    data-test="showcase"
    @mouseenter="hovering = true"
    @mouseleave="hovering = false"
    @focusin="focused = true"
    @focusout="onFocusOut"
    @keydown="onKeydown"
  >
    <div
      class="sulla-showcase-viewport"
      aria-live="polite"
      aria-atomic="true"
    >
      <Transition
        :name="reducedMotion ? '' : 'sulla-showcase-fade'"
        mode="out-in"
      >
        <article
          :key="current.id"
          class="sulla-showcase-slide"
          role="group"
          aria-roledescription="slide"
          :aria-label="`${index + 1} of ${slides.length}`"
          :data-test="`slide-${current.id}`"
        >
          <div
            class="sulla-showcase-art"
            aria-hidden="true"
          >
            <span class="sulla-showcase-ring r1" />
            <span class="sulla-showcase-ring r2" />
            <svg
              viewBox="0 0 48 48"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path
                v-for="(d, i) in ART[current.art]"
                :key="i"
                :d="d"
              />
            </svg>
          </div>
          <div class="sulla-showcase-copy">
            <p class="sulla-showcase-eyebrow">
              {{ current.eyebrow }}
            </p>
            <h3
              class="sulla-showcase-title"
              data-test="slide-title"
            >
              {{ titleOf(current) }}
            </h3>
            <p
              class="sulla-showcase-body"
              data-test="slide-body"
            >
              {{ current.body }}
            </p>
            <ul
              class="sulla-showcase-points"
              data-test="slide-points"
            >
              <li
                v-for="point in current.points"
                :key="point"
              >
                {{ point }}
              </li>
            </ul>
          </div>
        </article>
      </Transition>
    </div>

    <div class="sulla-showcase-controls">
      <button
        type="button"
        class="sulla-showcase-arrow"
        aria-label="Previous feature"
        data-test="prev"
        @click="go(-1)"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        ><path d="M15 18l-6-6 6-6" /></svg>
      </button>
      <div
        class="sulla-showcase-dots"
        role="group"
        aria-label="Choose a feature"
      >
        <button
          v-for="(slide, i) in slides"
          :key="slide.id"
          type="button"
          class="sulla-showcase-dot"
          :class="{ active: i === index }"
          :aria-label="`Show ${slide.eyebrow}`"
          :aria-current="i === index ? 'true' : undefined"
          data-test="dot"
          @click="show(i)"
        />
      </div>
      <button
        type="button"
        class="sulla-showcase-arrow"
        aria-label="Next feature"
        data-test="next"
        @click="go(1)"
      >
        <svg
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        ><path d="M9 18l6-6-6-6" /></svg>
      </button>
    </div>
  </section>
</template>

<script lang="ts">
import {
  computed, defineComponent, onMounted, onUnmounted, ref, watch, type PropType,
} from 'vue';

import {
  SHOWCASE_SLIDES, loadIntegrationCount, slideTitle,
  type ShowcaseArt, type ShowcaseSlide,
} from './startupShowcaseSlides';

/** Line-art icons, 48x48 grid. Pure inline SVG, no assets. */
const ART: Record<ShowcaseArt, string[]> = {
  agents:       ['M14 18h20v16H14z', 'M24 18v-6', 'M20 12h8', 'M19 25h.01', 'M29 25h.01', 'M20 30h8', 'M10 24h4', 'M34 24h4'],
  routines:     ['M24 8a16 16 0 1 0 16 16', 'M24 14v10l6 4', 'M40 8v8h-8'],
  vault:        ['M12 20h24v18H12z', 'M17 20v-5a7 7 0 0 1 14 0v5', 'M24 27v5'],
  files:        ['M14 8h14l8 8v24H14z', 'M28 8v8h8', 'M10 14v28h20'],
  models:       ['M24 6l16 9v18l-16 9-16-9V15z', 'M24 24l16-9', 'M24 24v18', 'M24 24L8 15'],
  integrations: ['M18 10v8', 'M30 10v8', 'M14 18h20v6a10 10 0 0 1-20 0z', 'M24 34v8'],
  projects:     ['M8 10h32v28H8z', 'M19 10v28', 'M30 10v28', 'M11 16h5', 'M22 16h5', 'M22 21h5', 'M33 16h4'],
  heartbeat:    ['M6 26h8l4-10 6 20 5-14 3 4h10'],
  secretary:    ['M24 8a6 6 0 0 0-6 6v10a6 6 0 0 0 12 0V14a6 6 0 0 0-6-6z', 'M12 22v2a12 12 0 0 0 24 0v-2', 'M24 36v6'],
  capture:      ['M6 14h26v20H6z', 'M32 21l10-6v18l-10-6', 'M14 20h.01'],
  phone:        ['M16 6h16v36H16z', 'M22 36h4', 'M21 18c2-2 4-2 6 0', 'M19 15c3-4 7-4 10 0'],
  sandbox:      ['M8 12h32v24H8z', 'M8 18h32', 'M14 26l4 4-4 4', 'M22 34h8'],
};

export default defineComponent({
  name:  'StartupShowcase',
  props: {
    slides:      { type: Array as PropType<ShowcaseSlide[]>, default: () => SHOWCASE_SLIDES },
    intervalMs:  { type: Number, default: 12000 },
    /** Injected for tests; defaults to the lazy catalog count. */
    countLoader: { type: Function as PropType<() => Promise<number | null>>, default: loadIntegrationCount },
  },
  setup(props, { expose }) {
    const index = ref(0);
    const hovering = ref(false);
    const focused = ref(false);
    const hidden = ref(false);
    const painted = ref(false);
    const reducedMotion = ref(false);
    const integrationCount = ref<number | null>(null);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let motionQuery: MediaQueryList | null = null;
    let disposed = false;

    const slides = computed(() => props.slides);
    const current = computed(() => slides.value[index.value % slides.value.length]);
    const paused = computed(() => hovering.value || focused.value || hidden.value || reducedMotion.value);

    function titleOf(slide: ShowcaseSlide): string {
      return slideTitle(slide, { integrationCount: integrationCount.value });
    }

    function clear() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    /** Restart the auto-advance countdown, unless something pauses it. */
    function schedule() {
      clear();
      if (paused.value || !painted.value) return;
      timer = setTimeout(() => {
        timer = null;
        // Advance on the next frame: a backgrounded window runs no frames, so
        // the slideshow waits there instead of queueing unseen transitions.
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            if (!paused.value && !disposed) go(1);
          });
        } else {
          go(1);
        }
      }, props.intervalMs);
    }

    function show(i: number) {
      const n = slides.value.length;

      index.value = ((i % n) + n) % n;
      schedule();
    }

    function go(delta: number) {
      show(index.value + delta);
    }

    function onKeydown(event: KeyboardEvent) {
      const moves: Record<string, () => void> = {
        ArrowRight: () => go(1),
        ArrowLeft:  () => go(-1),
        Home:       () => show(0),
        End:        () => show(slides.value.length - 1),
      };
      const move = moves[event.key];

      if (move) {
        event.preventDefault();
        move();
      }
    }

    function onFocusOut(event: FocusEvent) {
      const next = event.relatedTarget as Node | null;
      const root = event.currentTarget as HTMLElement | null;

      focused.value = !!(next && root?.contains(next));
    }

    function onVisibility() {
      hidden.value = document.visibilityState === 'hidden';
    }

    function onMotionChange() {
      reducedMotion.value = !!motionQuery?.matches;
    }

    // Synchronous so a pause takes effect before any pending timer can fire.
    watch(paused, () => schedule(), { flush: 'sync' });

    onMounted(() => {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion.value = motionQuery.matches;
        motionQuery.addEventListener?.('change', onMotionChange);
      }
      onVisibility();
      document.addEventListener('visibilitychange', onVisibility);

      // Render after the first paint so the slideshow never delays the progress view.
      const reveal = () => {
        painted.value = true;
        schedule();
        props.countLoader().then((n) => {
          integrationCount.value = n;
        }).catch(() => undefined);
      };

      // Frames may not run in a backgrounded window, so a timer backs up the frame.
      let revealed = false;
      const once = () => {
        if (!revealed) {
          revealed = true;
          reveal();
        }
      };

      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(once, 0));
      setTimeout(once, 250);
    });

    onUnmounted(() => {
      disposed = true;
      clear();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotionChange);
    });

    expose({ index, paused, reducedMotion });

    return {
      ART, index, painted, reducedMotion, current, titleOf, show, go, onKeydown, onFocusOut, hovering, focused,
    };
  },
});
</script>

<style scoped>
.sulla-showcase {
  --sc-ink: var(--nx-read-1, var(--text-primary, #e6edf3));
  --sc-read: var(--nx-read-2, var(--text-secondary, #c9d1d9));
  --sc-accent: var(--nx-accent, #5096b3);
  --sc-hair: var(--nx-hair-strong, rgba(168, 192, 220, 0.16));

  position: relative;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 32px 48px 12px;
  outline: none;
}

.sulla-showcase:focus-visible {
  box-shadow: inset 0 0 0 2px var(--sc-accent);
}

.sulla-showcase-viewport {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
}

.sulla-showcase-slide {
  display: grid;
  grid-template-columns: minmax(180px, 2fr) 3fr;
  gap: clamp(24px, 5vw, 64px);
  align-items: center;
  width: 100%;
  max-width: 62rem;
  margin: 0 auto;
}

.sulla-showcase-art {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 1;
  width: 100%;
  max-width: 340px;
  justify-self: center;
  border-radius: 32px;
  color: var(--sc-accent);
  background:
    radial-gradient(circle at 30% 25%, color-mix(in srgb, var(--sc-accent) 28%, transparent), transparent 62%),
    color-mix(in srgb, var(--sc-accent) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-accent) 30%, transparent), 0 24px 60px -24px color-mix(in srgb, var(--sc-accent) 55%, transparent);
  overflow: hidden;
}

.sulla-showcase-art svg {
  position: relative;
  width: 58%;
  height: 58%;
}

.sulla-showcase-ring {
  position: absolute;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sc-accent) 25%, transparent);
}
.sulla-showcase-ring.r1 { width: 78%; height: 78%; }
.sulla-showcase-ring.r2 { width: 104%; height: 104%; }

.sulla-showcase-copy {
  min-width: 0;
}

.sulla-showcase-eyebrow {
  margin: 0 0 10px;
  font-family: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--sc-accent);
}

.sulla-showcase-title {
  margin: 0;
  font-family: 'Playfair Display', Georgia, serif;
  font-weight: 600;
  font-size: clamp(28px, 4vw, 44px);
  line-height: 1.12;
  letter-spacing: -0.02em;
  color: var(--sc-ink);
}

.sulla-showcase-body {
  margin: 14px 0 0;
  font-family: Inter, 'Open Sans', system-ui, -apple-system, sans-serif;
  font-size: 16px;
  line-height: 1.6;
  color: var(--sc-read);
}

.sulla-showcase-points {
  margin: 20px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 10px;
  font-family: Inter, 'Open Sans', system-ui, -apple-system, sans-serif;
  font-size: 15px;
  color: var(--sc-ink);
}

.sulla-showcase-points li {
  position: relative;
  padding-left: 28px;
  line-height: 1.4;
}

.sulla-showcase-points li::before {
  content: '';
  position: absolute;
  left: 0;
  top: 1px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--sc-accent) 18%, transparent) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235096b3' stroke-width='3.2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 12.5l4 4 8-9'/%3E%3C/svg%3E") center / 12px no-repeat;
}

.sulla-showcase-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  margin-top: 8px;
}

.sulla-showcase-arrow {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 8px;
  color: var(--sc-read);
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--sc-hair);
  cursor: pointer;
}

.sulla-showcase-arrow:hover,
.sulla-showcase-arrow:focus-visible {
  color: var(--sc-ink);
  outline: 2px solid var(--sc-accent);
  outline-offset: 1px;
}

.sulla-showcase-dots {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 6px;
}

.sulla-showcase-dot {
  width: 8px;
  height: 8px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: color-mix(in srgb, var(--sc-read) 35%, transparent);
  cursor: pointer;
  transition: width 0.25s ease, background 0.25s ease;
}

.sulla-showcase-dot.active {
  width: 20px;
  border-radius: 4px;
  background: var(--sc-accent);
}

.sulla-showcase-dot:focus-visible {
  outline: 2px solid var(--sc-accent);
  outline-offset: 2px;
}

.sulla-showcase-fade-enter-active,
.sulla-showcase-fade-leave-active {
  transition: opacity 0.35s ease, transform 0.35s ease;
}

.sulla-showcase-fade-enter-from {
  opacity: 0;
  transform: translateX(12px);
}

.sulla-showcase-fade-leave-to {
  opacity: 0;
  transform: translateX(-12px);
}

@media (max-width: 720px) {
  .sulla-showcase { padding: 20px 20px 8px; }
  .sulla-showcase-slide { grid-template-columns: 1fr; gap: 16px; }
  .sulla-showcase-art { max-width: 120px; border-radius: 22px; }
  .sulla-showcase-body { font-size: 14px; }
  .sulla-showcase-points { font-size: 14px; margin-top: 12px; gap: 6px; }
}

@media (prefers-reduced-motion: reduce) {
  .sulla-showcase-dot,
  .sulla-showcase-fade-enter-active,
  .sulla-showcase-fade-leave-active { transition: none; }
}
</style>
