<template>
  <!-- Dim base track — always visible. Steel when idle, dim violet when
       flowing. Gives the edge a visible "body" underneath the traveling
       pulse, matching the L1 canvas design (gradient bar + animated flow). -->
  <path
    :id="`${ id }-base`"
    :d="pathD"
    class="routine-edge-base"
    :class="{ flowing, selected, failed }"
    fill="none"
  />

  <!-- Bright traveling pulse overlay — rendered only while flowing. A
       short round-capped dash with a long gap travels along the path,
       multi-layer drop-shadow gives the photon-streak glow. -->
  <path
    v-if="flowing"
    :d="pathD"
    class="routine-edge-pulse"
    fill="none"
  />

  <!-- Fat invisible interaction path so edges stay easy to click even
       though the visible stroke is thin. VueFlow's default edge does
       this — preserved here for hit-area parity. -->
  <path
    :id="id"
    :d="pathD"
    :data-id="id"
    class="vue-flow__edge-interaction"
    fill="none"
    stroke="transparent"
    stroke-width="18"
  />
</template>

<script setup lang="ts">
import { getSmoothStepPath, Position } from '@vue-flow/core';
import { computed } from 'vue';

/**
 * Custom routine edge — renders two stacked <path>s so we can have a
 * dim always-visible base AND a bright traveling pulse overlay when the
 * edge is "flowing" (source done → target running). VueFlow's default
 * edge only renders one path, so the design's base-track + animated-
 * pulse effect isn't achievable without a custom edge component.
 */
const props = defineProps<{
  id:             string;
  sourceX:        number;
  sourceY:        number;
  targetX:        number;
  targetY:        number;
  sourcePosition: Position;
  targetPosition: Position;
  animated?:      boolean;
  selected?:      boolean;
  data?:          Record<string, unknown>;
  markerEnd?:     string;
  markerStart?:   string;
}>();

// `animated` is VueFlow's flag flipped by AgentRoutines when the edge's
// target is the currently-running node (source done → target running).
const flowing = computed(() => !!props.animated);
const failed = computed(() => props.data?.status === 'failed');

// Smoothstep path matches the previous default so existing routines
// render with the same geometry — no layout shift when switching over.
const pathD = computed(() => {
  const [d] = getSmoothStepPath({
    sourceX:        props.sourceX,
    sourceY:        props.sourceY,
    sourcePosition: props.sourcePosition,
    targetX:        props.targetX,
    targetY:        props.targetY,
    targetPosition: props.targetPosition,
  });
  return d;
});
</script>

<style scoped>
/* Base track — the edge's visible body. Steel grey when idle, dim
   violet when its pair is flowing so the user sees a lit "rail" that
   the pulse is riding on. */
.routine-edge-base {
  stroke: rgba(168, 192, 220, 0.55);
  stroke-width: 2;
  transition: stroke 0.18s ease, stroke-width 0.18s ease, filter 0.18s ease;
}
.routine-edge-base.flowing {
  stroke: rgba(167, 139, 250, 0.45);
  stroke-width: 2;
  filter: drop-shadow(0 0 4px rgba(139, 92, 246, 0.35));
}
.routine-edge-base.failed {
  stroke: rgba(244, 63, 94, 0.6);
}
.routine-edge-base.selected {
  stroke: #60a5fa;
  stroke-width: 3;
  filter: drop-shadow(0 0 6px rgba(96, 165, 250, 0.75))
    drop-shadow(0 0 14px rgba(96, 165, 250, 0.35));
}

/* Pulse — a short round-capped dash travels along the full path with
   a long gap so only one bright segment is visible at any moment. The
   heavy drop-shadow stack gives the "photon streak" glow. Matches the
   L1 design's traveling violet gradient. */
.routine-edge-pulse {
  stroke: #ddd6fe;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 14 220;
  filter:
    drop-shadow(0 0 3px #ddd6fe)
    drop-shadow(0 0 8px rgba(167, 139, 250, 0.9))
    drop-shadow(0 0 18px rgba(139, 92, 246, 0.55))
    drop-shadow(0 0 32px rgba(139, 92, 246, 0.25));
  animation: routine-edge-flow 1.8s linear infinite;
  pointer-events: none;
}
@keyframes routine-edge-flow {
  from { stroke-dashoffset: 234; }
  to   { stroke-dashoffset: 0; }
}
</style>
