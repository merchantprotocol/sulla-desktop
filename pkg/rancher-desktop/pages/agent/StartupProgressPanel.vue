<template>
  <div
    class="sulla-sp"
    data-test="startup-progress"
  >
    <div class="sulla-sp-head">
      <p
        class="sulla-sp-phase"
        data-test="stage"
      >
        <span
          class="sulla-sp-pulse"
          :class="{ still: reducedMotion || !!snapshot?.error }"
          aria-hidden="true"
        />
        <template v-if="snapshot">
          Stage {{ snapshot.stageIndex }} of {{ snapshot.stageCount }} · {{ snapshot.stageLabel }}
        </template>
        <template v-else>
          Starting
        </template>
      </p>
      <p
        class="sulla-sp-elapsed"
        data-test="elapsed"
      >
        {{ formatDuration(totalElapsed) }}
      </p>
    </div>

    <p
      class="sulla-sp-step"
      data-test="step"
      aria-live="polite"
    >
      {{ stepLabel }}
    </p>
    <p
      v-if="snapshot && !snapshot.ready"
      class="sulla-sp-stepmeta"
      data-test="step-meta"
    >
      <span v-if="snapshot.stepIndex && snapshot.stepTotal">Step {{ snapshot.stepIndex }} of {{ snapshot.stepTotal }} · </span>{{ formatDuration(stepElapsed) }} on this step
    </p>

    <div
      class="sulla-sp-track"
      role="progressbar"
      aria-label="Startup progress"
      aria-valuemin="0"
      aria-valuemax="100"
      :aria-valuenow="Math.floor(displayed)"
      :aria-valuetext="`${Math.floor(displayed)}% · ${stepLabel}`"
    >
      <div
        class="sulla-sp-fill"
        :class="{ moving: !reducedMotion && !snapshot?.ready && !snapshot?.error }"
        data-test="fill"
        :style="{ transform: `scaleX(${(displayed / 100).toFixed(4)})` }"
      />
    </div>
    <p
      class="sulla-sp-percent"
      data-test="percent"
    >
      {{ Math.floor(displayed) }}%
    </p>

    <p
      v-if="slowNote"
      class="sulla-sp-note"
      data-test="slow-note"
    >
      This is taking a while. {{ slowNote }}
    </p>

    <div
      v-if="snapshot?.error || (snapshot?.failures.length ?? 0) > 0"
      class="sulla-sp-problem"
      role="status"
      data-test="failures"
    >
      <p class="sulla-sp-problem-title">
        {{ snapshot?.error || 'Some parts did not start.' }}
      </p>
      <ul>
        <li
          v-for="f in snapshot?.failures ?? []"
          :key="f.key"
        >
          <strong>{{ f.label }}</strong>: {{ f.message }}
        </li>
      </ul>
      <p class="sulla-sp-problem-hint">
        {{ snapshot?.error
          ? 'Restarting Sulla runs startup again. The logs have the details.'
          : 'Sulla keeps starting without them. Restarting Sulla tries them again.' }}
      </p>
    </div>

    <ol
      v-if="(snapshot?.feed.length ?? 0) > 0"
      class="sulla-sp-feed"
      aria-label="Recently finished"
      data-test="feed"
    >
      <li
        v-for="item in snapshot!.feed"
        :key="item.key"
        :class="`is-${item.status}`"
        data-test="feed-item"
      >
        <span
          class="sulla-sp-mark"
          aria-hidden="true"
        >{{ item.status === 'done' ? '✓' : item.status === 'failed' ? '!' : '–' }}</span>
        <span class="sulla-sp-feed-label">{{ item.label }}<span
          v-if="item.status !== 'done'"
          class="sulla-sp-visually-hidden"
        > ({{ item.status }})</span></span>
        <span class="sulla-sp-feed-time">{{ formatDuration(item.durationMs) }}</span>
      </li>
    </ol>
  </div>
</template>

<script lang="ts">
import {
  computed, defineComponent, onMounted, onUnmounted, ref, watch, type PropType,
} from 'vue';

import {
  formatDuration, nextDisplayed, slowStepNote, type StartupProgressSnapshot,
} from '@pkg/utils/startupProgress';

export default defineComponent({
  name:  'StartupProgressPanel',
  props: {
    snapshot:        { type: Object as PropType<StartupProgressSnapshot | null>, default: null },
    /** Used only when no snapshot has arrived (older main process). */
    fallbackPercent: { type: Number, default: 0 },
    fallbackLabel:   { type: String, default: 'Starting Sulla…' },
    /** Injected for tests. */
    now:             { type: Function as PropType<() => number>, default: () => Date.now() },
  },
  setup(props, { expose }) {
    const displayed = ref(0);
    const clock = ref(props.now());
    const reducedMotion = ref(false);
    let frame: number | null = null;
    let ticker: ReturnType<typeof setInterval> | null = null;
    let lastFrame = 0;
    /** Wall-clock time of the last animation frame; frames stop when the window is backgrounded. */
    let lastFrameWall = 0;
    let motionQuery: MediaQueryList | null = null;

    const target = computed(() => props.snapshot ? props.snapshot.percent : Math.max(0, Math.min(100, props.fallbackPercent)));
    const boundary = computed(() => props.snapshot ? props.snapshot.nextBoundary : target.value);
    const stepLabel = computed(() => props.snapshot?.stepLabel || props.fallbackLabel);
    const stepElapsed = computed(() => props.snapshot ? Math.max(0, clock.value - props.snapshot.stepStartedAt) : 0);
    const totalElapsed = computed(() => props.snapshot ? Math.max(0, clock.value - props.snapshot.startedAt) : 0);
    const slowNote = computed(() => {
      const s = props.snapshot;

      return s && !s.ready && !s.error ? slowStepNote(s.stepKey, stepElapsed.value) : null;
    });

    /** One smoothing step: ease toward the target, creep while a step runs. */
    function advance(dtMs: number) {
      clock.value = props.now();
      if (reducedMotion.value || props.snapshot?.ready || props.snapshot?.error) {
        displayed.value = Math.max(displayed.value, target.value);

        return;
      }
      displayed.value = nextDisplayed(displayed.value, target.value, boundary.value, stepElapsed.value, dtMs);
    }

    function loop(ts: number) {
      const dt = lastFrame ? Math.min(250, ts - lastFrame) : 16;

      lastFrame = ts;
      lastFrameWall = Date.now();
      advance(dt);
      frame = requestAnimationFrame(loop);
    }

    function stopLoop() {
      if (frame !== null && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
      frame = null;
      if (ticker) clearInterval(ticker);
      ticker = null;
    }

    function startLoop() {
      stopLoop();
      if (typeof requestAnimationFrame === 'function' && !reducedMotion.value) {
        lastFrame = 0;
        frame = requestAnimationFrame(loop);
      }
      // The clock always ticks once a second. When no frame has run lately
      // (reduced motion, or a backgrounded window), the ticker moves the bar.
      ticker = setInterval(() => advance(Date.now() - lastFrameWall > 500 ? 1000 : 0), 1000);
    }

    function onVisibility() {
      if (document.visibilityState === 'hidden') stopLoop();
      else startLoop();
    }

    function onMotionChange() {
      reducedMotion.value = !!motionQuery?.matches;
      startLoop();
    }

    // A new startup (backend restart) is the one time the bar may start over.
    watch(() => props.snapshot?.startedAt, (next, prev) => {
      if (next && prev && next !== prev) displayed.value = target.value;
    });

    // Real events jump the reduced-motion display straight to the new target.
    watch(target, () => {
      if (reducedMotion.value) advance(0);
    });

    onMounted(() => {
      if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
        reducedMotion.value = motionQuery.matches;
        motionQuery.addEventListener?.('change', onMotionChange);
      }
      displayed.value = reducedMotion.value ? target.value : 0;
      document.addEventListener('visibilitychange', onVisibility);
      startLoop();
    });

    onUnmounted(() => {
      stopLoop();
      document.removeEventListener('visibilitychange', onVisibility);
      motionQuery?.removeEventListener?.('change', onMotionChange);
    });

    expose({ displayed, advance, reducedMotion });

    return {
      displayed, reducedMotion, stepLabel, stepElapsed, totalElapsed, slowNote, formatDuration, advance,
    };
  },
});
</script>

<style scoped>
.sulla-sp {
  --sp-ink: var(--nx-read-1, var(--text-primary, #e6edf3));
  --sp-read: var(--nx-read-2, var(--text-secondary, #c9d1d9));
  --sp-accent: var(--nx-accent, #5096b3);
  --sp-accent-2: var(--nx-accent-2, #6ab0cc);
  --sp-hair: var(--nx-hair-strong, rgba(168, 192, 220, 0.16));
  --sp-track: var(--bg-surface-alt, var(--bg-surface-hover, #21262d));
  --sp-danger: var(--nx-danger, #f85149);
  --sp-mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;

  text-align: left;
  font-family: Inter, 'Open Sans', system-ui, -apple-system, sans-serif;
}

.sulla-sp-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.sulla-sp-phase,
.sulla-sp-elapsed,
.sulla-sp-percent,
.sulla-sp-stepmeta {
  margin: 0;
  font-family: var(--sp-mono);
  font-size: 11.5px;
  letter-spacing: 0.04em;
  color: var(--sp-read);
  font-variant-numeric: tabular-nums;
}

.sulla-sp-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

.sulla-sp-pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sp-accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--sp-accent) 60%, transparent);
  animation: sulla-sp-pulse 1.6s ease-out infinite;
}

.sulla-sp-pulse.still { animation: none; }

.sulla-sp-step {
  margin: 14px 0 2px;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.35;
  color: var(--sp-ink);
}

.sulla-sp-track {
  position: relative;
  margin-top: 14px;
  height: 8px;
  overflow: hidden;
  border-radius: 8px;
  background: var(--sp-track);
  box-shadow: inset 0 0 0 1px var(--sp-hair);
}

.sulla-sp-fill {
  position: absolute;
  inset: 0;
  transform-origin: left center;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--sp-accent), var(--sp-accent-2));
  will-change: transform;
}

.sulla-sp-fill.moving::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 30%, rgba(255, 255, 255, 0.28) 50%, transparent 70%);
  transform: translateX(-100%);
  animation: sulla-sp-shimmer 1.8s ease-in-out infinite;
}

.sulla-sp-percent {
  margin-top: 6px;
  text-align: right;
}

.sulla-sp-note {
  margin: 12px 0 0;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--sp-read);
  background: color-mix(in srgb, var(--sp-accent) 9%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sp-accent) 22%, transparent);
}

.sulla-sp-problem {
  margin-top: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--sp-ink);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--sp-danger) 45%, transparent);
  background: color-mix(in srgb, var(--sp-danger) 7%, transparent);
}

.sulla-sp-problem p { margin: 0; }
.sulla-sp-problem-title { font-weight: 600; }
.sulla-sp-problem ul { margin: 6px 0; padding-left: 18px; }
.sulla-sp-problem-hint { color: var(--sp-read); }

.sulla-sp-feed {
  list-style: none;
  margin: 14px 0 0;
  padding: 10px 0 0;
  border-top: 1px solid var(--sp-hair);
}

.sulla-sp-feed li {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 2px 0;
  font-size: 12.5px;
  color: var(--sp-read);
}

.sulla-sp-mark {
  width: 12px;
  font-family: var(--sp-mono);
  color: var(--sp-accent);
}

.sulla-sp-feed li.is-failed .sulla-sp-mark { color: var(--sp-danger); }

.sulla-sp-feed-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sulla-sp-feed-time {
  font-family: var(--sp-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
}

.sulla-sp-visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@keyframes sulla-sp-shimmer { to { transform: translateX(100%); } }
@keyframes sulla-sp-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--sp-accent) 55%, transparent); }
  100% { box-shadow: 0 0 0 7px transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .sulla-sp-pulse,
  .sulla-sp-fill.moving::after { animation: none; }
}
</style>
