<template>
  <div
    class="t02"
    :class="[stateClass, { 'menu-open': menuOpen, 'is-loop': isLoop, 'is-selected': selected }]"
  >
    <!-- Default target handle — suppressed for loop cards (which own their
         own four-handle layout below) and triggers (which are graph
         entry points with no inbound edge). -->
    <Handle
      v-if="!isLoop && !isTrigger"
      type="target"
      :position="Position.Left"
      class="t02-handle"
    />

    <!-- Loop-specific handles: In (top), Start (bottom), Back (right),
         Exit (left). Each handle sits at its natural edge; labels float
         just outside the card so the user can see which connector is
         which. Design carried over from the original workflow editor. -->
    <template v-if="isLoop">
      <Handle
        id="loop-entry"
        type="target"
        :position="Position.Top"
        class="t02-handle loop-dot"
      />
      <span class="loop-label loop-label-top">In</span>

      <Handle
        id="loop-start"
        type="source"
        :position="Position.Bottom"
        class="t02-handle loop-dot"
      />
      <span class="loop-label loop-label-bottom">Start</span>

      <Handle
        id="loop-back"
        type="target"
        :position="Position.Right"
        class="t02-handle loop-dot"
      />
      <span class="loop-label loop-label-right">Back</span>

      <Handle
        id="loop-exit"
        type="source"
        :position="Position.Left"
        class="t02-handle loop-dot"
      />
      <span class="loop-label loop-label-left">Exit</span>
    </template>

    <div class="inner">
      <div class="stub">
        <div class="no">
          {{ data.nodeCode }}
        </div>
        <div
          class="av"
          :class="avatarClass"
        >
          <!-- Order: registry-provided SVG icon > emoji string from
               data.avatar.icon > derived initials. The SVG path keeps
               every subtype looking consistent with the legacy editor
               without requiring every node to carry display fields. -->
          <span
            v-if="iconSvg"
            class="av-icon-svg"
            v-html="iconSvg"
          />
          <span v-else-if="data.avatar?.icon">{{ data.avatar.icon }}</span>
          <span v-else>{{ data.avatar?.initials }}</span>
        </div>
        <div class="st">
          {{ statusLabel }}
        </div>
      </div>

      <div class="col">
        <div class="body">
          <div class="k">
            {{ data.kicker }}
          </div>
          <div class="tt">
            {{ data.title || data.label }}
          </div>
          <div
            v-if="data.role"
            class="r"
          >
            {{ data.role }}
          </div>
          <div
            v-if="data.quote"
            class="q"
          >
            {{ data.quote }}
          </div>
        </div>
        <div class="wb-foot">
          <span class="m">
            <template v-if="elapsedLabel">
              <span
                class="elapsed"
                :class="{ live: effectiveState === 'running' }"
              >{{ elapsedLabel }}</span>
            </template>
            <template v-else>
              <strong v-if="data.metricsStrong">{{ data.metricsStrong }}</strong>
              <template v-if="data.metrics">{{ data.metrics }}</template>
            </template>
          </span>
          <span
            class="qp"
            :class="footerStatusClass"
          >{{ data.footerRight || '—' }}</span>
        </div>
      </div>
    </div>

    <button
      v-if="isEditMode"
      class="menu-btn nodrag"
      :class="{ active: menuOpen }"
      type="button"
      @pointerdown.stop
      @click.stop="toggleMenu"
    >⋯</button>

    <div
      v-if="menuOpen && isEditMode"
      class="flyout nodrag"
      @pointerdown.stop
      @click.stop
    >
      <div class="item">
        <span class="k">Edit agent</span><span class="sc">⌘E</span>
      </div>
      <div class="item">
        <span class="k">Run from here</span><span class="sc">⌘R</span>
      </div>
      <div class="item">
        <span class="k">Duplicate</span><span class="sc">⌘D</span>
      </div>
      <div class="item">
        <span class="k">Inspect output</span>
      </div>
      <div class="sep" />
      <div class="item">
        <span class="k">Pause</span>
      </div>
      <div class="item">
        <span class="k">Replace…</span>
      </div>
      <div class="sep" />
      <div class="item danger">
        <span class="k">Remove from flow</span>
      </div>
    </div>

    <!-- Default source handle — suppressed for nodes that render their
         own multi-handle layout (loop, condition, router). -->
    <Handle
      v-if="!isLoop && !hasRouteHandles"
      type="source"
      :position="Position.Right"
      class="t02-handle"
    />

    <!-- Route handles for condition (true/false) and router (N routes).
         Each handle is explicitly positioned by leftPercent so adding a
         new route never causes overlap — VueFlow's default would stack
         every Position.Bottom handle at the card's center-bottom. The
         matching label is absolutely positioned below the card at the
         same percent so handle + label stay paired regardless of count. -->
    <template v-if="hasRouteHandles">
      <Handle
        v-for="route in routeHandles"
        :key="`h-${ route.id }`"
        :id="route.id"
        type="source"
        :position="Position.Bottom"
        class="t02-handle route-handle-dot"
        :style="{ left: `${ route.leftPercent }%` }"
      />
      <div class="route-labels-bar">
        <span
          v-for="route in routeHandles"
          :key="`l-${ route.id }`"
          class="route-handle-label"
          :style="{ left: `${ route.leftPercent }%` }"
        >{{ route.label }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core';
import { computed, inject, onBeforeUnmount, ref, type Ref } from 'vue';

import { useLiveClock } from '@pkg/composables/useLiveClock';

import { getNodeDefinition } from '@pkg/pages/editor/workflow/nodeRegistry';

/**
 * Execution state emitted by PlaybookController and attached to
 * `data.execution`. Thinking output is displayed in the top-left live
 * stream panel (see AgentRoutines.vue), not on the node itself.
 */
interface NodeExecutionState {
  status?:      'running' | 'completed' | 'failed' | 'waiting' | 'skipped';
  output?:      unknown;
  error?:       string;
  startedAt?:   number;
  completedAt?: number;
}

interface RoutineNodeData {
  state?:         'idle' | 'queued' | 'running' | 'done' | 'failed';
  nodeCode?:      string;
  kicker?:        string;
  /** Primary display name. Falls back to `label` for legacy nodes. */
  title?:         string;
  /** Legacy display name used by the older workflow YAML. */
  label?:         string;
  subtype?:       string;
  category?:      string;
  role?:          string;
  quote?:         string;
  metrics?:       string;
  metricsStrong?: string;
  footerRight?:   string;
  avatar?:        {
    type?:     'trigger' | 'tool' | 'agent' | 'logic' | 'loop' | 'default';
    icon?:     string;
    initials?: string;
  };
  /** Per-node configuration — shape depends on subtype. */
  config?:    Record<string, unknown>;
  /** Live execution state written by PlaybookController during a run. */
  execution?: NodeExecutionState;
}

const props = defineProps<{
  id:        string;
  data:      RoutineNodeData;
  selected?: boolean;
}>();

const menuOpen = ref(false);

const routinesMode = inject<Ref<'edit' | 'run'>>('routines-mode');
const isEditMode = computed(() => routinesMode?.value === 'edit');

// Loop nodes carry four labeled handles (In / Start / Back / Exit)
// instead of the usual left-target / right-source pair. Detect them up
// front so the template can switch layouts cleanly.
const isLoop = computed(() => props.data.subtype === 'loop');

// Triggers are the graph entry point — they only emit, never receive.
// Suppress the default left-side target handle so users can't wire
// inbound edges into something that will never consume them.
const isTrigger = computed(() => {
  return props.data.category === 'trigger'
    || props.data.avatar?.type === 'trigger';
});

// Condition and router nodes fan out into multiple labeled source
// handles. Condition is fixed at True/False; router grows with the
// node's config.routes array, so adding a route in the config panel
// surfaces a new handle automatically.
interface RouteHandle {
  id:    string;
  label: string;
  /** 0–100 percentage along the card's bottom edge. Applied to both the
   *  Handle and the label so they stay aligned when routes are added or
   *  removed. Without this every handle would stack at center-bottom
   *  (VueFlow's default Position.Bottom) and overlap. */
  leftPercent: number;
}

function distributeRoutes<T extends { id: string; label: string }>(raw: T[]): RouteHandle[] {
  const n = raw.length;
  return raw.map((r, idx) => ({
    ...r,
    leftPercent: ((idx + 0.5) / n) * 100,
  }));
}

const routeHandles = computed<RouteHandle[]>(() => {
  const subtype = props.data.subtype;

  if (subtype === 'condition') {
    return distributeRoutes([
      { id: 'condition-true',  label: 'True' },
      { id: 'condition-false', label: 'False' },
    ]);
  }

  if (subtype === 'router') {
    const routes = (props.data.config?.routes as Array<{ label?: string }> | undefined) ?? [];
    if (routes.length === 0) {
      // A router with no configured routes still needs a source handle
      // so the user can wire *something* before committing to a config.
      return distributeRoutes([{ id: 'route-0', label: 'Default' }]);
    }

    return distributeRoutes(routes.map((r, idx) => ({
      id:    `route-${ idx }`,
      label: (r.label && String(r.label).trim()) || `Route ${ idx + 1 }`,
    })));
  }

  return [];
});

const hasRouteHandles = computed(() => routeHandles.value.length > 0);

// Per-subtype SVG icon, sourced from the shared node registry. Keeps
// icon ownership in one place (same lookup the legacy workflow renderer
// used) so every subtype has the right glyph on the canvas without
// needing `data.avatar.icon` on every node.
const iconSvg = computed<string>(() => {
  const subtype = props.data.subtype;
  if (!subtype) return '';

  return getNodeDefinition(subtype)?.iconSvg ?? '';
});

// Merge the PlaybookController-emitted `data.execution.status` vocabulary
// into our own state vocab. When both are present, execution wins —
// that's the runtime truth. When neither is present, we land on 'idle'.
const effectiveState = computed<NonNullable<RoutineNodeData['state']>>(() => {
  const exec = props.data.execution?.status;
  if (exec === 'running')   return 'running';
  if (exec === 'completed') return 'done';
  if (exec === 'failed')    return 'failed';
  if (exec === 'waiting')   return 'queued';
  if (exec === 'skipped')   return 'idle';

  return props.data.state ?? 'idle';
});

const stateClass = computed(() => effectiveState.value);

const statusLabel = computed(() => {
  switch (effectiveState.value) {
  case 'running': return 'Live';
  case 'done':    return 'Done';
  case 'queued':  return 'Queue';
  case 'failed':  return 'Fail';
  default:        return 'Idle';
  }
});

const avatarClass = computed(() => {
  const t = props.data.avatar?.type;

  return t && t !== 'default' ? t : '';
});

const footerStatusClass = computed(() => {
  switch (effectiveState.value) {
  case 'running': return 'running';
  case 'done':    return 'done';
  case 'failed':  return 'failed';
  default:        return 'idle';
  }
});

// Shared 1 Hz clock — one setInterval feeds every card on the canvas so
// thirty running nodes don't mean thirty timers. Ticks only exist while
// any node is live (see `useLiveClock` for ref-counted lifecycle).
const now = useLiveClock();

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    const mm = m % 60;
    return `${ h }h ${ String(mm).padStart(2, '0') }m`;
  }
  return m > 0 ? `${ m }m ${ String(s).padStart(2, '0') }s` : `${ s }s`;
}

// Live elapsed for the running state, frozen duration for the done state.
// Queued/idle/failed cards show nothing so the stub stays compact.
const elapsedLabel = computed(() => {
  const exec = props.data.execution;
  if (!exec?.startedAt) return '';
  if (effectiveState.value === 'running') {
    return formatDuration(now.value - exec.startedAt);
  }
  if (effectiveState.value === 'done' && exec.completedAt) {
    return formatDuration(exec.completedAt - exec.startedAt);
  }
  return '';
});

function toggleMenu() {
  menuOpen.value = !menuOpen.value;
  if (menuOpen.value) {
    document.addEventListener('click', closeOnOutside, { capture: true });
  } else {
    document.removeEventListener('click', closeOnOutside, { capture: true });
  }
}

function closeOnOutside(_e: MouseEvent) {
  menuOpen.value = false;
  document.removeEventListener('click', closeOnOutside, { capture: true });
}

onBeforeUnmount(() => {
  document.removeEventListener('click', closeOnOutside, { capture: true });
});
</script>

<style scoped>
.t02 {
  --steel-100: #c4d4e6;
  --steel-200: #a8c0dc;
  --steel-300: #8cacc9;
  --steel-400: #6989b3;
  --steel-500: #4a6fa5;
  --steel-600: #375789;
  --steel-700: #2c4871;
  --violet-200: #ddd6fe;
  --violet-300: #c4b5fd;
  --violet-400: #a78bfa;
  --violet-500: #8b5cf6;
  --violet-600: #7c3aed;
  --amber-400: #f59e0b;
  --amber-600: #d97706;
  --teal-400: #06b6d4;
  --teal-600: #0891b2;
  --rose-300: #fda4af;
  --rose-400: #fb7185;
  --rose-500: #f43f5e;
  --rose-600: #e11d48;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --serif: "Iowan Old Style", "Palatino", Georgia, serif;

  width: 210px;
  display: flex;
  position: relative;
  background: transparent;
  border-radius: 10px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.4);
  color: #e6ecf5;
  font-family: var(--font);
}
.t02 .inner {
  flex: 1;
  display: flex;
  /* Consistent minimum height so cards with short content still leave
     room for the footer to sit at the bottom of the card rather than
     floating up against the body. */
  min-height: 122px;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(24, 36, 62, 0.95), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.14);
}
.t02.running .inner {
  border-color: rgba(167, 139, 250, 0.55);
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.2), 0 0 36px rgba(139, 92, 246, 0.28);
}
/* Done state: subtle green completion glow + a thin check tick over the
   avatar so completed cards read at a glance as "ran and finished"
   without stealing attention from whichever node is currently live. */
.t02.done .inner {
  opacity: 0.94;
  border-color: rgba(122, 212, 168, 0.35);
  box-shadow: 0 0 0 1px rgba(122, 212, 168, 0.14), 0 0 22px rgba(52, 160, 110, 0.18);
}
.t02.done .stub { border-right-color: rgba(122, 212, 168, 0.4); }
.t02.done .wb-foot { background: rgba(52, 160, 110, 0.06); }
.t02.done .wb-foot .qp { color: #7ad4a8; }
.t02.done .wb-foot .qp::before { background: #7ad4a8; }
.t02.failed .inner {
  border-color: rgba(244, 63, 94, 0.55);
  box-shadow: 0 0 0 1px rgba(244, 63, 94, 0.2), 0 0 32px rgba(244, 63, 94, 0.28);
}

/* Selection ring — sits outside the border as a steel-blue halo so the
   card's own border/running/failed styling remains untouched. Uses
   double box-shadow: a solid 2px ring hugging the radius plus a soft
   outer glow so it reads as "lit" rather than "outlined". */
.t02.is-selected .inner {
  border-color: rgba(106, 176, 204, 0.75);
  box-shadow:
    0 0 0 2px rgba(106, 176, 204, 0.85),
    0 0 0 4px rgba(106, 176, 204, 0.28),
    0 0 26px rgba(80, 150, 179, 0.45);
}
.t02.is-selected.running .inner {
  /* When both states apply, blend the selection ring with the running
     glow — keep the violet interior shadow, swap the outer ring to
     steel-blue so selection stays legible. */
  box-shadow:
    0 0 0 2px rgba(106, 176, 204, 0.85),
    0 0 0 4px rgba(106, 176, 204, 0.28),
    0 0 36px rgba(139, 92, 246, 0.28);
}
.t02.is-selected.failed .inner {
  box-shadow:
    0 0 0 2px rgba(106, 176, 204, 0.85),
    0 0 0 4px rgba(106, 176, 204, 0.28),
    0 0 32px rgba(244, 63, 94, 0.28);
}

.t02 .stub {
  width: 56px;
  padding: 10px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-right: 2px dashed rgba(168, 192, 220, 0.28);
  text-align: center;
}
.t02.running .stub { border-right-color: rgba(167, 139, 250, 0.5); }
.t02.failed .stub  { border-right-color: rgba(244, 63, 94, 0.5); }
.t02 .stub .no {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-400);
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
/* Avatar color = node type. Intentionally does NOT react to running /
   done / failed — the card's border, inner shadow, stub-dash, and
   footer already carry state; the avatar stays a stable identifier of
   what kind of node this is. */
.t02 .stub .av {
  width: 34px;
  height: 34px;
  border-radius: 9px;
  margin: 5px 0 4px;
  display: grid;
  place-items: center;
  color: white;
  font-weight: 800;
  font-size: 11px;
  background: linear-gradient(135deg, var(--steel-400), var(--steel-700));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
.t02 .stub .av.trigger { background: linear-gradient(135deg, var(--amber-400), var(--amber-600)); }
.t02 .stub .av.tool    { background: linear-gradient(135deg, var(--teal-400), var(--teal-600)); }
.t02 .stub .av.logic   { background: linear-gradient(135deg, #94a3b8, #475569); }
.t02 .stub .av.loop    { background: linear-gradient(135deg, #8fb3d9, var(--steel-600)); }
.t02 .stub .av.agent   { background: linear-gradient(135deg, var(--violet-400), var(--violet-600)); }
.t02 .stub .st {
  font-family: var(--mono);
  font-size: 8px;
  letter-spacing: 0.18em;
  color: var(--steel-300);
  text-transform: uppercase;
}
.t02.running .stub .st { color: var(--violet-300); }
.t02.done .stub .st    { color: #7ad4a8; }
.t02.failed .stub .st  { color: var(--rose-400); }

/* Elapsed/duration readout in the footer left slot. Tabular digits so
   the counter doesn't jitter as seconds tick up. */
.wb-foot .m .elapsed {
  font-family: var(--mono);
  font-size: 10px;
  color: var(--steel-200);
  letter-spacing: 0.05em;
  font-variant-numeric: tabular-nums;
}
.wb-foot .m .elapsed.live {
  color: var(--violet-200);
  text-shadow: 0 0 6px rgba(139, 92, 246, 0.55);
}
.t02.done .wb-foot .m .elapsed { color: #7ad4a8; }

.t02 .col {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.t02 .body {
  padding: 9px 28px 9px 10px;
  position: relative;
}
.t02 .body .k {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.t02.running .body .k { color: var(--violet-300); }
.t02.failed  .body .k { color: var(--rose-400); }
.t02 .body .tt {
  font-family: var(--serif);
  font-size: 14px;
  font-style: italic;
  color: white;
  line-height: 1.15;
  margin-top: 2px;
}
.t02 .body .r {
  font-size: 10px;
  color: var(--steel-200);
  opacity: 0.85;
  margin-top: 3px;
}
.t02 .body .q {
  margin-top: 7px;
  padding-left: 7px;
  border-left: 2px solid var(--steel-400);
  font-family: var(--serif);
  font-size: 10.5px;
  font-style: italic;
  color: #b5ccdf;
  line-height: 1.35;
}
.t02.running .body .q {
  border-left-color: var(--violet-400);
  color: var(--violet-300);
}
.t02.failed .body .q {
  border-left-color: var(--rose-400);
  color: var(--rose-300);
}

.wb-foot {
  /* Push to the bottom of .col (a flex column) regardless of body
     length, so every node's footer aligns at the same place. */
  margin-top: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  background: rgba(105, 137, 179, 0.08);
  border-top: 1px solid rgba(168, 192, 220, 0.14);
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--steel-300);
  letter-spacing: 0.04em;
}
.wb-foot .m { display: inline-flex; align-items: center; gap: 4px; }
.wb-foot .m strong { color: white; font-weight: 700; margin-right: 2px; }
.wb-foot .qp {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #8fb3d9;
  font-weight: 700;
}
.wb-foot .qp::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #5b84b8;
}
.wb-foot .qp.idle { color: var(--steel-400); }
.wb-foot .qp.idle::before { background: var(--steel-600); }
.wb-foot .qp.running { color: var(--violet-300); }
.wb-foot .qp.running::before {
  background: var(--violet-400);
  box-shadow: 0 0 6px var(--violet-400);
  animation: t02-pulse 1s infinite;
}
.wb-foot .qp.failed { color: var(--rose-400); }
.wb-foot .qp.failed::before {
  background: var(--rose-400);
  box-shadow: 0 0 6px var(--rose-400);
}
.t02.running .wb-foot {
  background: rgba(139, 92, 246, 0.1);
  border-top-color: rgba(167, 139, 250, 0.25);
}
.t02.failed .wb-foot {
  background: rgba(244, 63, 94, 0.08);
  border-top-color: rgba(244, 63, 94, 0.25);
}
@keyframes t02-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

.menu-btn {
  position: absolute;
  top: 6px;
  right: 8px;
  width: 20px;
  height: 20px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--steel-300);
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  letter-spacing: 0.1em;
  background: transparent;
  border: none;
  z-index: 4;
}
.menu-btn:hover { background: rgba(168, 192, 220, 0.1); color: white; }
.menu-btn.active { background: rgba(167, 139, 250, 0.22); color: white; }
.t02.running .menu-btn { color: var(--violet-300); }

.flyout {
  position: absolute;
  top: 30px;
  right: 6px;
  z-index: 10;
  min-width: 170px;
  background: linear-gradient(180deg, rgba(24, 36, 62, 0.98), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.22);
  border-radius: 8px;
  box-shadow: 0 14px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4);
  padding: 5px;
}
.flyout .item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 5px;
  font-size: 11px;
  color: var(--steel-100);
  font-family: var(--font);
  cursor: pointer;
}
.flyout .item:hover { background: rgba(167, 139, 250, 0.14); color: white; }
.flyout .item .k { flex: 1; }
.flyout .item .sc {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-400);
  letter-spacing: 0.08em;
}
.flyout .sep {
  height: 1px;
  background: rgba(168, 192, 220, 0.12);
  margin: 3px 2px;
}
.flyout .item.danger { color: #fca5a5; }
.flyout .item.danger:hover { background: rgba(239, 68, 68, 0.15); color: #fee2e2; }

/* Tiny handles — keep connection points but minimal visual noise */
.t02-handle {
  width: 8px;
  height: 8px;
  background: rgba(168, 192, 220, 0.5);
  border: 1px solid rgba(14, 22, 40, 0.8);
}
.t02.running .t02-handle {
  background: var(--violet-400);
  box-shadow: 0 0 6px rgba(139, 92, 246, 0.6);
}

/* Condition / router — labeled source handles spread evenly along the
   card's bottom edge. Each handle + label is absolutely positioned by
   its route.leftPercent so adding a route rebalances the layout instead
   of stacking. */
.t02-handle.route-handle-dot {
  width: 10px;
  height: 10px;
  background: var(--steel-300);
  border-color: rgba(14, 22, 40, 0.9);
  /* Default VueFlow applies `transform: translate(-50%, 50%)` to
     Position.Bottom handles; that centers each handle on its (left, 100%)
     anchor so our leftPercent reads as "center the dot at this X". */
}
.t02.running .t02-handle.route-handle-dot {
  background: var(--violet-300);
}
.route-labels-bar {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -26px;
  height: 18px;
  pointer-events: none;
}
.route-handle-label {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.14em;
  color: var(--steel-300);
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
}

/* Loop cards — four labeled handles. Dots are slightly larger and
   brighter so the user can see which side is which; labels float just
   outside the card near their dot. */
.t02.is-loop .t02-handle.loop-dot {
  width: 10px;
  height: 10px;
  background: var(--steel-300);
  border-color: rgba(14, 22, 40, 0.9);
}
.t02.is-loop.running .t02-handle.loop-dot {
  background: var(--violet-300);
}
.loop-label {
  position: absolute;
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--steel-300);
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
  z-index: 3;
}
.loop-label-top {
  top: -4px;
  left: 50%;
  transform: translate(-50%, -100%);
}
.loop-label-bottom {
  bottom: -4px;
  left: 50%;
  transform: translate(-50%, 100%);
}
.loop-label-right {
  right: -10px;
  top: 50%;
  transform: translate(100%, -50%);
}
.loop-label-left {
  left: -10px;
  top: 50%;
  transform: translate(-100%, -50%);
}

/* ── Registry-sourced icon inside the avatar square ──
   Fills the avatar cell with the SVG the node registry publishes for
   each subtype. `:deep()` reaches into the inlined SVG (rendered via
   v-html) so it inherits white stroke/fill on our dark card. */
.av-icon-svg {
  display: grid;
  place-items: center;
  width: 20px;
  height: 20px;
  color: white;
}
.av-icon-svg :deep(svg) {
  width: 100%;
  height: 100%;
  stroke: currentColor;
  fill: none;
}

</style>
