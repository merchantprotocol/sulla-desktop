<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div ref="surface" class="handoff" :class="`handoff-${layout.style}`" aria-label="Recorded handoffs">
    <svg v-if="wires.length" class="handoff-wires" aria-hidden="true">
      <path
        v-for="wire in wires"
        :key="wire.key"
        :d="wire.path"
        :data-handoff-from="wire.from"
        :data-handoff-to="wire.key"
        :class="{ 'handoff-follow': wire.kind === 'follow-up' }"
      />
    </svg>
    <div
      v-for="{ node, depth } in ordered"
      :key="node.row.key"
      :ref="element => setCard(node.row.key, element)"
      class="handoff-node"
      :style="{ '--handoff-depth': depth }"
    >
      <slot :node="node" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue';

import { AgentWorkTree, type AgentWorkLink, type AgentWorkNode } from '../../messages/AgentWorkTree';

const props = defineProps<{ nodes: AgentWorkNode[]; drawLinks: boolean }>();
const layout = computed(() => props.drawLinks ? AgentWorkTree.layout(props.nodes) : { rows: [props.nodes], incoming: new Map<string, AgentWorkLink>(), style: 'list' });
const ordered = computed(() => {
  if (layout.value.style === 'list') return props.nodes.map(node => ({ node, depth: 0 }));
  const children = new Map<string, AgentWorkNode[]>();
  for (const node of props.nodes) {
    const link = layout.value.incoming.get(node.row.key);
    if (link) children.set(link.key, [...children.get(link.key) ?? [], node]);
  }
  function order(node: AgentWorkNode, depth: number): { node: AgentWorkNode; depth: number }[] {
    return [{ node, depth }, ...(children.get(node.row.key) ?? []).flatMap(child => order(child, depth + 1))];
  }
  return layout.value.rows[0].flatMap(node => order(node, 0));
});
const surface = ref<HTMLElement>();
const cards = new Map<string, HTMLElement>();
const wires = ref<{ key: string; from: string; kind: AgentWorkLink['kind']; path: string }[]>([]);
let observer: ResizeObserver | undefined;

function setCard(key: string, element: Element | ComponentPublicInstance | null): void {
  if (element instanceof HTMLElement) {
    if (cards.get(key) === element) return;
    cards.set(key, element);
    observer?.observe(element);
  } else {
    const previous = cards.get(key);
    if (previous) observer?.unobserve(previous);
    cards.delete(key);
  }
}

function draw(): void {
  if (!surface.value || layout.value.style === 'list') { wires.value = []; return }
  const bounds = surface.value.getBoundingClientRect();
  if (!bounds.width) { wires.value = []; return }
  const next = [];
  for (const [key, link] of layout.value.incoming) {
    // Details grow below the button. A handoff belongs to the summary even when its card expands.
    const from = cards.get(link.key)?.querySelector('[data-job-key]')?.getBoundingClientRect();
    const to = cards.get(key)?.querySelector('[data-job-key]')?.getBoundingClientRect();
    if (!from?.width || !to?.width) continue;
    const x = from.left - bounds.left;
    const y = from.top + from.height / 2 - bounds.top;
    const targetY = to.top + to.height / 2 - bounds.top;
    const track = x - 6;
    next.push({ key, from: link.key, kind: link.kind, path: `M ${ x } ${ y } H ${ track } V ${ targetY } H ${ to.left - bounds.left }` });
  }
  wires.value = next;
}

onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(draw);
    if (surface.value) observer.observe(surface.value);
    for (const card of cards.values()) observer.observe(card);
  }
  draw();
});
watch(layout, () => nextTick(draw));
onBeforeUnmount(() => observer?.disconnect());
</script>

<style scoped>
.handoff { position: relative; display: grid; gap: 8px; min-width: 0; isolation: isolate; }
.handoff-node { min-width: 0; }
.handoff-map .handoff-node, .handoff-fan .handoff-node {
  margin-left: calc(8px + var(--handoff-depth) * 13px);
}
.handoff-wires { position: absolute; inset: 0; z-index: -1; width: 100%; height: 100%; pointer-events: none; }
.handoff-wires path { stroke: var(--accent); stroke-width: 1.5; stroke-opacity: .7; fill: none; }
.handoff-wires .handoff-follow { stroke: var(--status-warning); stroke-dasharray: 3 3; }
</style>
