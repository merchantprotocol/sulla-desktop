<template>
  <div
    class="loop-frame"
    :class="[
      stateClass,
      {
        'is-selected':    selected,
        'is-drop-target': isDropTarget,
      },
    ]"
  >
    <!-- Top-left pill: loop label -->
    <div class="loop-label">
      <span class="ic">↻</span>
      <span>{{ labelText }}</span>
    </div>

    <!-- Top-right pill: iteration counter (live) or mode hint (idle) -->
    <div class="loop-counter">
      <span v-if="counterStrong"><b>{{ counterStrong }}</b>&nbsp;</span>
      <span>{{ counterText }}</span>
    </div>

    <!-- No handles on the frame itself — edges connect directly to the
         child nodes inside. Body semantics (entry / exit / iteration
         order) are inferred at execution time from nesting + edges. -->

    <!-- Resize grabs — eight handles around the frame's perimeter. Edit
         mode only; `.nodrag` keeps VueFlow from hijacking the pointer
         for node drag, `pointerdown.stop` keeps pane-drag from firing
         when the user starts a resize on the frame edge. -->
    <template v-if="isEditMode">
      <div
        v-for="dir in RESIZE_DIRS"
        :key="dir"
        class="resize nodrag"
        :class="dir"
        @pointerdown.stop="beginResize($event, dir)"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { useVueFlow } from '@vue-flow/core';
import { computed, inject, type Ref } from 'vue';

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

// Minimum frame size — sub-minimum would make the label/counter collide
// with the handles, and the frame would be too small to drop anything
// useful inside. Width fits one routine card (210px) + padding.
const MIN_W = 280;
const MIN_H = 160;

/**
 * Loop container — a dashed frame that wraps its body nodes instead of
 * sitting next to them. Body nodes are registered as VueFlow children
 * (node.parentNode = this loop's id) in phase 2. In phase 1 the frame is
 * drawn but stands alone.
 *
 * Styled from the L3 "loop" variation in
 * _design-ideas/canvas-workflow-compositions.html — steel-blue dashed
 * border when idle, violet solid-glow when an iteration is active.
 */
interface LoopExecutionState {
  status?:           'running' | 'completed' | 'failed' | 'waiting' | 'skipped';
  currentIteration?: number;
  totalIterations?:  number;
  currentItemLabel?: string;
  startedAt?:        number;
  completedAt?:      number;
}

interface LoopNodeData {
  state?:     'idle' | 'queued' | 'running' | 'done' | 'failed';
  title?:     string;
  label?:     string;
  subtype?:   string;
  config?:    Record<string, unknown>;
  execution?: LoopExecutionState;
}

const props = defineProps<{
  id:        string;
  data:      LoopNodeData;
  selected?: boolean;
}>();

const routinesMode = inject<Ref<'edit' | 'run'>>('routines-mode');
const isEditMode = computed(() => routinesMode?.value === 'edit');

// Shared ref from AgentRoutines — holds the id of the loop frame that's
// currently the drop target (either for a library drag or an on-canvas
// node drag). When it matches our id, we light the frame up so the user
// knows their release will land inside.
const dropTargetLoopId = inject<Ref<string | null>>('routines-drop-target-loop');
const isDropTarget = computed(() => dropTargetLoopId?.value === props.id);

// Same state-priority rule as RoutineNode: live execution.status wins,
// then the static data.state, then 'idle'.
const effectiveState = computed<NonNullable<LoopNodeData['state']>>(() => {
  const exec = props.data.execution?.status;
  if (exec === 'running')   return 'running';
  if (exec === 'completed') return 'done';
  if (exec === 'failed')    return 'failed';
  if (exec === 'waiting')   return 'queued';
  if (exec === 'skipped')   return 'idle';

  return props.data.state ?? 'idle';
});

const stateClass = computed(() => effectiveState.value);

// Left pill — labels the loop's TYPE (reacts to loopMode changes in the
// config drawer). The user's title/label lives inside the frame body if
// needed; the pill is reserved for "what kind of loop is this".
const labelText = computed(() => {
  const mode = props.data.config?.loopMode as string | undefined;
  switch (mode) {
  case 'for-each':         return 'Loop · For Each';
  case 'ask-orchestrator': return 'Loop · Adaptive';
  case 'iterations':       return 'Loop · Iterations';
  default:                 return 'Loop';
  }
});

// Right pill — iteration progress during a run, or the configured
// iteration hint when idle. Never the type (that's the left pill's job).
const counterStrong = computed(() => {
  const exec = props.data.execution;
  if (exec?.currentIteration != null && exec.totalIterations != null) {
    return `${ exec.currentIteration } / ${ exec.totalIterations }`;
  }
  return '';
});

const counterText = computed(() => {
  const exec = props.data.execution;
  if (exec?.currentIteration != null && exec.totalIterations != null) {
    const label = exec.currentItemLabel;
    return label ? `· ${ label }` : '';
  }

  // Idle — describe the iteration count/source so the user can see
  // "how many" at a glance without opening the config drawer.
  const cfg = props.data.config ?? {};
  const mode = cfg.loopMode as string | undefined;
  if (mode === 'for-each')         return 'per item';
  if (mode === 'ask-orchestrator') return 'runtime';
  const max = cfg.maxIterations;
  if (max)                         return `max ${ max }`;
  return '—';
});

// ── Resize ──
// VueFlow exposes `findNode` and `getViewport` via useVueFlow. We read the
// current width/height/position off the node, listen for pointermove while
// the user drags a grab handle, and mutate width/height (and position, if
// resizing from a N/W edge so the frame grows outward the right way).
const { findNode, getViewport } = useVueFlow();

function beginResize(e: PointerEvent, dir: ResizeDir) {
  const node = findNode(props.id);
  if (!node) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const startW = node.dimensions?.width  ?? (node as any).width  ?? 560;
  const startH = node.dimensions?.height ?? (node as any).height ?? 220;
  const startPos = { x: node.position.x, y: node.position.y };

  const onMove = (ev: PointerEvent) => {
    // Convert screen-space delta to world-space by dividing by zoom so
    // the grab handle tracks the cursor 1:1 regardless of canvas zoom.
    const zoom = getViewport().zoom || 1;
    const dx = (ev.clientX - startX) / zoom;
    const dy = (ev.clientY - startY) / zoom;

    let w = startW;
    let h = startH;
    let px = startPos.x;
    let py = startPos.y;

    if (dir.includes('e')) w = Math.max(MIN_W, startW + dx);
    if (dir.includes('s')) h = Math.max(MIN_H, startH + dy);
    if (dir.includes('w')) {
      const newW = Math.max(MIN_W, startW - dx);
      px = startPos.x + (startW - newW);
      w = newW;
    }
    if (dir.includes('n')) {
      const newH = Math.max(MIN_H, startH - dy);
      py = startPos.y + (startH - newH);
      h = newH;
    }

    (node as any).width = w;
    (node as any).height = h;
    node.position = { x: px, y: py };
  };

  const onUp = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('pointercancel', onUp);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('pointercancel', onUp);
}

</script>

<style scoped>
.loop-frame {
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
  --rose-400: #fb7185;
  --rose-500: #f43f5e;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;

  /* Fill the VueFlow node wrapper (which sizes via node.width/height) so
     resize changes the frame 1:1 without JS reflow. */
  position: relative;
  width: 100%;
  height: 100%;
  padding: 26px 16px 14px;
  /* Purple dashed frame by default — matches the L3 "active" look in the
     design mockup. Loops are loops regardless of whether they're running;
     running state just pulses harder (see .loop-frame.running). */
  border: 1.5px dashed rgba(167, 139, 250, 0.6);
  border-radius: 14px;
  background: rgba(52, 40, 90, 0.22);
  color: #e6ecf5;
  font-family: var(--font);
  box-sizing: border-box;
  box-shadow: inset 0 0 32px rgba(139, 92, 246, 0.1);
  /* No flex layout here — children are VueFlow-managed and sit outside
     this element in the DOM tree. We just draw the frame chrome. */
}

.loop-frame.running {
  border-color: rgba(196, 181, 253, 0.75);
  background: rgba(58, 42, 100, 0.32);
  box-shadow: inset 0 0 40px rgba(139, 92, 246, 0.2), 0 0 38px rgba(139, 92, 246, 0.28);
}

/* Drop-target state — something is being dragged over this loop and a
   release here will nest it inside. Bright-violet solid border with a
   pulsing glow so the user can't miss that the drop is "catching". */
.loop-frame.is-drop-target {
  border-style: solid;
  border-color: rgba(196, 181, 253, 0.95);
  background: rgba(70, 52, 120, 0.42);
  box-shadow:
    inset 0 0 50px rgba(139, 92, 246, 0.28),
    0 0 42px rgba(139, 92, 246, 0.45);
  animation: loop-drop-pulse 0.9s ease-in-out infinite;
}
@keyframes loop-drop-pulse {
  0%,100% { box-shadow: inset 0 0 50px rgba(139,92,246,0.28), 0 0 42px rgba(139,92,246,0.45); }
  50%     { box-shadow: inset 0 0 60px rgba(139,92,246,0.42), 0 0 58px rgba(139,92,246,0.65); }
}
.loop-frame.done {
  border-color: rgba(122, 212, 168, 0.45);
  background: rgba(40, 72, 58, 0.22);
  box-shadow: inset 0 0 30px rgba(52, 160, 110, 0.12);
}
.loop-frame.failed {
  border-color: rgba(244, 63, 94, 0.55);
  background: rgba(72, 32, 44, 0.28);
  box-shadow: inset 0 0 30px rgba(244, 63, 94, 0.15);
}

/* Selection ring — steel-blue halo outside the dashed border. */
.loop-frame.is-selected {
  box-shadow:
    0 0 0 2px rgba(106, 176, 204, 0.75),
    0 0 0 4px rgba(106, 176, 204, 0.22),
    0 0 26px rgba(80, 150, 179, 0.35);
}
.loop-frame.is-selected.running {
  box-shadow:
    0 0 0 2px rgba(106, 176, 204, 0.75),
    0 0 0 4px rgba(106, 176, 204, 0.22),
    inset 0 0 40px rgba(139, 92, 246, 0.15),
    0 0 32px rgba(139, 92, 246, 0.2);
}

/* ── Top-left pill: loop label ── */
.loop-label {
  position: absolute;
  top: -11px;
  left: 16px;
  padding: 3px 10px;
  border-radius: 4px;
  /* Violet gradient by default (matches L3 active look). */
  background: linear-gradient(135deg, var(--violet-500), var(--violet-600));
  border: 1px solid rgba(196, 181, 253, 0.5);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.18em;
  color: white;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  z-index: 2;
}
.loop-frame.running .loop-label {
  box-shadow: 0 0 14px rgba(139, 92, 246, 0.55);
}
.loop-frame.done .loop-label {
  background: linear-gradient(135deg, #4a9874, #2f855a);
  border-color: rgba(122, 212, 168, 0.45);
}
.loop-frame.failed .loop-label {
  background: linear-gradient(135deg, var(--rose-400), var(--rose-500));
  border-color: rgba(253, 164, 175, 0.45);
}
.loop-label .ic {
  display: inline-block;
  font-size: 11px;
  line-height: 1;
}

/* ── Top-right pill: iteration counter ── */
.loop-counter {
  position: absolute;
  top: -11px;
  right: 16px;
  padding: 3px 10px;
  border-radius: 4px;
  background: rgba(28, 20, 50, 0.95);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.1em;
  color: var(--violet-300);
  text-transform: uppercase;
  border: 1px solid rgba(167, 139, 250, 0.4);
  z-index: 2;
  white-space: nowrap;
}
.loop-frame.running .loop-counter {
  box-shadow: 0 0 10px rgba(139, 92, 246, 0.35);
}
.loop-counter b { color: white; font-weight: 800; }
.loop-frame.running .loop-counter b { color: white; }

/* ── Handles — sit on the frame's outer edges, violet when active ── */
/* ── Resize grabs ──
   Edges are thin slivers that span the frame minus the corners; corners
   are small circular dots that sit slightly outside the border so they
   never overlap the content. All invisible until hover for a clean
   default look, then a faint violet tint appears so the user can find
   the corner without having to hunt for pixels. */
.resize {
  position: absolute;
  z-index: 5;
  pointer-events: all;
  background: transparent;
  transition: background 0.12s ease, box-shadow 0.12s ease;
}
.resize.n, .resize.s {
  left: 14px;
  right: 14px;
  height: 8px;
  cursor: ns-resize;
}
.resize.n { top: -4px; }
.resize.s { bottom: -4px; }
.resize.e, .resize.w {
  top: 14px;
  bottom: 14px;
  width: 8px;
  cursor: ew-resize;
}
.resize.e { right: -4px; }
.resize.w { left: -4px; }

/* Corners get an invisible hit area — the cursor change on hover is the
   only affordance. User said the dashed border is a clear-enough
   resize cue; explicit dots added visual noise. */
.resize.ne, .resize.nw, .resize.se, .resize.sw {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  border: none;
  background: transparent;
}
.resize.ne { top: -7px; right: -7px; cursor: nesw-resize; }
.resize.nw { top: -7px; left: -7px;  cursor: nwse-resize; }
.resize.se { bottom: -7px; right: -7px; cursor: nwse-resize; }
.resize.sw { bottom: -7px; left: -7px;  cursor: nesw-resize; }
</style>
