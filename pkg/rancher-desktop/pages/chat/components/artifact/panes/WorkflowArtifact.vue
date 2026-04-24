<!--
  Node-graph artifact. Consumes the routine.yaml shape directly — no field
  mapping. Node coordinates come from `node.position.{x,y}`; labels and
  category badges from `node.data.{label,subtype}`. Runtime state (active
  / done / error) layers on via the optional `runtimeState` field, which
  is absent during authoring and present during execution. Edges use the
  same `source`/`target` field names the routine YAML uses.
-->
<template>
  <div class="wf-canvas">
    <div
      v-for="e in payload.edges"
      :key="e.id"
      :class="['wf-edge', e.runtimeState ?? 'idle']"
      :style="edgeStyle(e)"
    />
    <div
      v-for="n in payload.nodes"
      :key="n.id"
      :class="['wf-node', n.runtimeState ?? 'idle']"
      :style="{ left: n.position.x + 'px', top: n.position.y + 'px' }"
    >
      <div class="kicker">{{ n.data.subtype }}</div>
      <div class="nm">{{ n.data.label }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { WorkflowPayload, WorkflowEdge } from '../../../models/Artifact';

const props = defineProps<{ payload: WorkflowPayload }>();

function edgeStyle(e: WorkflowEdge): Record<string, string> {
  const a = props.payload.nodes.find(n => n.id === e.source);
  const b = props.payload.nodes.find(n => n.id === e.target);
  if (!a || !b) return { display: 'none' };
  const x1 = a.position.x + 140, y1 = a.position.y + 24;
  const x2 = b.position.x,       y2 = b.position.y + 24;
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy);
  const ang = Math.atan2(dy, dx) * 180 / Math.PI;
  return {
    left: x1 + 'px', top: y1 + 'px',
    width: len + 'px',
    transform: `rotate(${ang}deg)`,
  };
}
</script>

<style scoped>
.wf-canvas {
  position: relative; width: 100%; height: 100%;
  background-image:
    linear-gradient(rgba(80, 150, 179, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(80, 150, 179, 0.04) 1px, transparent 1px);
  background-size: 24px 24px;
  background-position: 12px 12px;
  border-radius: 8px;
  overflow: hidden;
}
.wf-node {
  position: absolute;
  min-width: 140px; padding: 10px 14px;
  border-radius: 8px;
  background: rgba(20, 30, 42, 0.85);
  border: 1px solid rgba(80, 150, 179, 0.3);
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  font-family: var(--mono); font-size: 11px;
  color: var(--read-1);
}
.wf-node .kicker {
  font-size: 9px; letter-spacing: 0.22em; text-transform: uppercase;
  color: var(--steel-400); margin-bottom: 4px;
}
.wf-node .nm { font-family: var(--serif); font-style: italic; font-size: 13px; }
.wf-node.start { background: rgba(80, 150, 179, 0.14); border-color: rgba(80, 150, 179, 0.5); }
.wf-node.active {
  border: 2px solid var(--steel-400);
  box-shadow: 0 0 20px rgba(106, 176, 204, 0.4), 0 4px 20px rgba(0,0,0,0.4);
}
.wf-node.active::before {
  content: ""; position: absolute; top: -4px; right: -4px;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 10px var(--steel-400);
  animation: chat-pulse 1.5s infinite;
}
.wf-node.done { opacity: 0.75; }
.wf-node.done::after {
  content: "✓"; position: absolute; top: -6px; right: -6px;
  width: 14px; height: 14px; border-radius: 50%;
  background: var(--ok); color: #012; font-size: 9px; font-weight: 900;
  display: flex; align-items: center; justify-content: center;
}
.wf-node.error {
  border-color: var(--err);
}
.wf-edge {
  position: absolute; background: rgba(80, 150, 179, 0.3); height: 2px;
  transform-origin: left center;
}
.wf-edge.active {
  background: linear-gradient(90deg, rgba(106, 176, 204, 0.6), var(--steel-400), rgba(106, 176, 204, 0.6));
  box-shadow: 0 0 8px rgba(106, 176, 204, 0.4);
}
.wf-edge.active::after {
  content: ""; position: absolute; top: -3px; left: 0;
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--steel-400); box-shadow: 0 0 12px var(--steel-400);
  animation: wf-pulse 2s linear infinite;
}
@keyframes wf-pulse {
  0%   { left: 0%; opacity: 1; }
  80%  { left: 95%; opacity: 1; }
  100% { left: 100%; opacity: 0; }
}
</style>
