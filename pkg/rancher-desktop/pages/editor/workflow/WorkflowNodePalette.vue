<template>
  <div class="node-palette" :class="{ dark: isDark }">
    <div v-for="category in CATEGORY_ORDER" :key="category" class="palette-category">
      <div class="category-header" :class="{ dark: isDark }">
        <span class="category-label">{{ CATEGORY_LABELS[category] }}</span>
      </div>
      <div class="category-grid">
        <div
          v-for="nodeDef in getNodesByCategory(category)"
          :key="nodeDef.subtype"
          class="palette-card"
          :class="{ dark: isDark }"
          draggable="true"
          @dragstart="onDragStart($event, nodeDef.subtype, nodeDef.category)"
        >
          <div class="palette-card-icon">
            <img
              v-if="nodeDef.useImageIcon"
              :src="sullaIconUrl"
              class="palette-icon-img"
              :alt="nodeDef.label"
            />
            <span v-else class="palette-icon-svg" v-html="nodeDef.iconSvg"></span>
          </div>
          <div class="palette-card-label">{{ nodeDef.label }}</div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { WorkflowNodeCategory, WorkflowNodeSubtype } from './types';
import { getNodesByCategory, CATEGORY_LABELS, CATEGORY_ORDER } from './nodeRegistry';

defineProps<{
  isDark: boolean;
}>();

const sullaIconUrl = new URL('../../../../../resources/icons/sulla-node-icon.png', import.meta.url).href;

function onDragStart(event: DragEvent, subtype: WorkflowNodeSubtype, category: WorkflowNodeCategory) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('application/vueflow', JSON.stringify({ subtype, category }));
  event.dataTransfer.effectAllowed = 'move';
}
</script>

<style scoped>
.node-palette {
  padding: 8px;
  overflow-y: auto;
  flex: 1;
}

.palette-category {
  margin-bottom: 12px;
}

.category-header {
  padding: 0 4px 6px;
  border-bottom: 1px solid #e2e8f0;
  margin-bottom: 8px;
}

.category-header.dark {
  border-bottom-color: #3c3c5c;
}

.category-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.category-header.dark .category-label {
  color: #94a3b8;
}

.category-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}

.palette-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 10px 4px;
  border: 1px solid #e2e8f0;
  border-radius: 8px;
  background: #fff;
  cursor: grab;
  transition: border-color 0.15s, box-shadow 0.15s;
  user-select: none;
}

.palette-card:hover {
  border-color: #cbd5e1;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.palette-card:active {
  cursor: grabbing;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.palette-card.dark {
  background: #2d2d44;
  border-color: #3c3c5c;
}

.palette-card.dark:hover {
  border-color: #4a4a6a;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.palette-card-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #64748b;
}

.palette-card.dark .palette-card-icon {
  color: #94a3b8;
}

.palette-icon-img {
  width: 24px;
  height: 24px;
  border-radius: 4px;
  object-fit: contain;
}

.palette-icon-svg {
  display: flex;
  align-items: center;
  justify-content: center;
}

.palette-card-label {
  font-size: 10px;
  color: #475569;
  text-align: center;
  line-height: 1.2;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-card.dark .palette-card-label {
  color: #94a3b8;
}
</style>
