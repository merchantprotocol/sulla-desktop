<template>
  <div v-if="visible" class="ctx-menu-backdrop" @click="$emit('close')" @contextmenu.prevent="$emit('close')"></div>
  <div
    v-if="visible"
    ref="menuEl"
    class="ctx-menu"
    :style="menuStyle"
  >
    <div v-if="title" class="ctx-menu-header">{{ title }}</div>
    <template v-for="item in items" :key="item.id">
      <!-- Submenu parent -->
      <div
        v-if="item.children"
        class="ctx-menu-sub-parent"
        @mouseenter="openSub(item.id, $event)"
        @mouseleave="startCloseSub"
      >
        <button class="ctx-menu-item ctx-menu-has-sub">
          {{ item.label }}
          <svg class="ctx-menu-arrow" viewBox="0 0 6 10" fill="none" stroke="currentColor" stroke-width="1.5"><polyline points="1,1 5,5 1,9"/></svg>
        </button>

        <!-- Flyout submenu -->
        <div
          v-if="openSubId === item.id"
          ref="subEl"
          class="ctx-menu ctx-menu-flyout"
          :style="subStyle"
          @mouseenter="cancelCloseSub"
          @mouseleave="startCloseSub"
        >
          <template v-for="child in item.children" :key="child.id">
            <div v-if="child.divider" class="ctx-menu-divider"></div>
            <button
              v-else
              class="ctx-menu-item"
              :class="{ active: child.active }"
              @click="child.action(); $emit('close')"
            >
              <img v-if="child.thumbnail" :src="child.thumbnail" class="ctx-menu-thumb" />
              {{ child.label }}
              <span v-if="child.badge" class="ctx-menu-badge">{{ child.badge }}</span>
            </button>
          </template>
        </div>
      </div>

      <!-- Regular item -->
      <button
        v-else-if="!item.divider"
        class="ctx-menu-item"
        :class="{ active: item.active }"
        @click="item.action(); $emit('close')"
      >
        <img v-if="item.thumbnail" :src="item.thumbnail" class="ctx-menu-thumb" />
        {{ item.label }}
        <span v-if="item.badge" class="ctx-menu-badge">{{ item.badge }}</span>
      </button>

      <!-- Divider -->
      <div v-else class="ctx-menu-divider">
        <span v-if="item.label" class="ctx-menu-section">{{ item.label }}</span>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';

export interface CtxMenuItem {
  id: string;
  label: string;
  thumbnail?: string;
  active?: boolean;
  divider?: boolean;
  badge?: string;
  children?: CtxMenuItem[];
  action: () => void;
}

const props = defineProps<{
  visible: boolean;
  x: number;
  y: number;
  title?: string;
  items: CtxMenuItem[];
}>();

defineEmits<{
  (e: 'close'): void;
}>();

const menuEl = ref<HTMLElement | null>(null);
const subEl = ref<HTMLElement | null>(null);
const menuWidth = ref(0);
const menuHeight = ref(0);

// Viewport-clamped position for the root menu
const menuStyle = computed(() => {
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = menuWidth.value || 240;
  const h = menuHeight.value || 200;

  let left = props.x;
  let top = props.y;

  // Clamp right edge
  if (left + w + pad > vw) left = vw - w - pad;
  // Clamp bottom edge
  if (top + h + pad > vh) top = vh - h - pad;
  // Clamp left/top
  if (left < pad) left = pad;
  if (top < pad) top = pad;

  return { left: `${left}px`, top: `${top}px` };
});

// Measure root menu after it renders
watch(() => props.visible, async (v) => {
  if (v) {
    await nextTick();
    await nextTick(); // double-tick to ensure DOM measured
    if (menuEl.value) {
      menuWidth.value = menuEl.value.offsetWidth;
      menuHeight.value = menuEl.value.offsetHeight;
    }
  }
});

// ─── Submenu flyout logic ───
const openSubId = ref<string | null>(null);
let closeTimer: ReturnType<typeof setTimeout> | null = null;

const subStyle = ref<Record<string, string>>({});

function openSub(id: string, event: MouseEvent) {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  openSubId.value = id;

  nextTick(() => {
    nextTick(() => {
      positionSub(event);
    });
  });
}

function positionSub(event: MouseEvent) {
  const parent = (event.currentTarget as HTMLElement);
  const parentRect = parent.getBoundingClientRect();
  const rootRect = menuEl.value?.getBoundingClientRect();
  if (!rootRect) return;

  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const subWidth = 220;
  const subHeight = subEl.value?.offsetHeight || 200;

  // Try to open to the right of the root menu
  let left = rootRect.right + 2;
  // If it would go off the right edge, open to the left instead
  if (left + subWidth + pad > vw) {
    left = rootRect.left - subWidth - 2;
  }
  if (left < pad) left = pad;

  // Align top with the hovered item
  let top = parentRect.top;
  // Clamp bottom
  if (top + subHeight + pad > vh) top = vh - subHeight - pad;
  if (top < pad) top = pad;

  subStyle.value = {
    position: 'fixed',
    left: `${left}px`,
    top: `${top}px`,
  };
}

function startCloseSub() {
  closeTimer = setTimeout(() => { openSubId.value = null; }, 200);
}

function cancelCloseSub() {
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
}

// Reset submenu when menu closes
watch(() => props.visible, (v) => {
  if (!v) {
    openSubId.value = null;
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  }
});
</script>
