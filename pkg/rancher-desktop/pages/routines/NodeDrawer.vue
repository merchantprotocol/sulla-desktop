<template>
  <aside
    class="node-drawer"
    :class="{ open }"
    @click.stop
  >
    <header class="d-head">
      <div class="title">
        <div class="k">
          {{ view === 'integrations' ? 'Integrations · browse by category' : `Library · ${ totalCount } nodes` }}
        </div>
        <div class="t">
          Drag a card
        </div>
      </div>
      <button
        type="button"
        class="close"
        aria-label="Close"
        @click="$emit('close')"
      >
        ✕
      </button>
    </header>

    <div class="d-search">
      <span>⌕</span>
      <span class="placeholder">Search…</span>
      <span class="sc">⌘K</span>
    </div>

    <div class="d-split">
      <!-- LEFT: sliding two-page nav -->
      <nav class="d-cats">
        <Transition
          name="slide-nav"
          mode="out-in"
        >
          <!-- Page 1: top-level categories -->
          <div
            v-if="view === 'root'"
            key="root"
            class="nav-page"
          >
            <button
              v-for="group in library"
              :key="group.category"
              type="button"
              class="cat"
              :class="{ active: activeCategory === group.category }"
              @click="selectRootCategory(group.category)"
            >
              <span class="nm">{{ group.label }}</span>
              <span class="cnt">{{ group.items.length }}</span>
            </button>

            <div class="cat-divider" />

            <button
              type="button"
              class="cat cat-special"
              @click="openIntegrations"
            >
              <span class="nm">Integrations</span>
              <span class="arr">›</span>
            </button>
          </div>

          <!-- Page 2: integration sub-categories -->
          <div
            v-else
            key="integrations"
            class="nav-page"
          >
            <button
              type="button"
              class="cat cat-back"
              @click="closeIntegrations"
            >
              <span class="arr">‹</span>
              <span class="nm">Back</span>
            </button>

            <div class="cat-divider" />

            <button
              v-for="cat in integrationCategories"
              :key="cat"
              type="button"
              class="cat"
              :class="{ active: activeIntegrationCategory === cat }"
              @click="selectIntegrationCategory(cat)"
            >
              <span class="nm">{{ cat }}</span>
            </button>
          </div>
        </Transition>
      </nav>

      <!-- RIGHT: draggable preview cards for the active selection -->
      <div class="d-cards">
        <Transition
          name="fade"
          mode="out-in"
        >
          <!-- Root cards -->
          <div
            v-if="view === 'root'"
            key="root-cards"
            class="cards-page"
          >
            <template
              v-for="item in activeItems"
              :key="item.id"
            >
              <!-- Loop items render as a mini dashed frame so the drawer
                   preview matches the thing that lands on the canvas —
                   WYSIWYG. Same drag payload as the regular card path. -->
              <div
                v-if="item.subtype === 'loop'"
                class="drag-card drag-card-loop"
                draggable="true"
                :data-subtype="item.subtype"
                @dragstart="onDragStart($event, item)"
              >
                <div class="loop-preview">
                  <div class="loop-preview-label">
                    <span class="ic">↻</span>
                    <span>Loop · {{ item.name || 'for each' }}</span>
                  </div>
                  <div class="loop-preview-counter">iteration</div>
                  <div class="loop-preview-hint">
                    Drag me onto the canvas<br>then drop cards inside
                  </div>
                </div>
                <div class="grab-hint">⁞⁞</div>
              </div>

              <!-- Generic card (everything else). -->
              <div
                v-else
                class="drag-card"
                draggable="true"
                :data-subtype="item.subtype"
                @dragstart="onDragStart($event, item)"
              >
                <div class="stub">
                  <div class="no">
                    {{ item.code }}
                  </div>
                  <div
                    class="av"
                    :class="item.avatarType"
                  >
                    {{ item.initials }}
                  </div>
                  <div class="st">
                    {{ item.kicker }}
                  </div>
                </div>
                <div class="body">
                  <div class="k">
                    {{ item.kicker }}
                  </div>
                  <div class="t">
                    {{ item.name }}
                  </div>
                  <div
                    v-if="item.role"
                    class="r"
                  >
                    {{ item.role }}
                  </div>
                  <div
                    v-if="item.quote"
                    class="q"
                  >
                    {{ item.quote }}
                  </div>
                </div>
                <div class="grab-hint">⁞⁞</div>
              </div>
            </template>
          </div>

          <!-- Integration cards -->
          <div
            v-else
            key="int-cards"
            class="cards-page"
          >
            <div
              v-if="!activeIntegrationCategory"
              class="empty-hint"
            >
              <span class="ico">◈</span>
              <span>Pick a category on the left.</span>
            </div>

            <div
              v-else-if="loadingIntegrations"
              class="empty-hint"
            >
              <span class="ico">◷</span>
              <span>Loading {{ activeIntegrationCategory }}…</span>
            </div>

            <div
              v-else-if="integrationItems.length === 0"
              class="empty-hint"
            >
              <span class="ico">∅</span>
              <span>No integrations in {{ activeIntegrationCategory }} yet.</span>
            </div>

            <template v-else>
              <div
                v-for="int in integrationItems"
                :key="int.id"
                class="drag-card"
                draggable="true"
                :data-integration="int.id"
                @dragstart="onIntegrationDragStart($event, int)"
              >
                <div class="stub">
                  <div class="no">
                    I-{{ int.id.slice(0, 3).toUpperCase() }}
                  </div>
                  <div class="av tool">
                    {{ initials(int.name) }}
                  </div>
                  <div class="st">
                    Integration
                  </div>
                </div>
                <div class="body">
                  <div class="k">
                    {{ int.category }}
                  </div>
                  <div class="t">
                    {{ int.name }}
                  </div>
                  <div
                    v-if="int.description"
                    class="q"
                  >
                    "{{ int.description }}"
                  </div>
                </div>
                <div class="grab-hint">⁞⁞</div>
              </div>
            </template>
          </div>
        </Transition>
      </div>
    </div>

    <footer class="d-foot">
      <span class="tip">Drag any card <b>→</b> canvas</span>
      <span>Esc to close</span>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

import {
  INTEGRATION_CATEGORIES,
  loadIntegrationsFor,
  ROUTINE_LIBRARY,
  ROUTINE_LIBRARY_BY_CATEGORY,
  type Integration,
  type RoutineLibraryItem,
} from './libraryMapping';

defineProps<{ open: boolean }>();
defineEmits<{ close: [] }>();

const library = ROUTINE_LIBRARY_BY_CATEGORY;
const totalCount = computed(() => ROUTINE_LIBRARY.length);

type DrawerView = 'root' | 'integrations';
const view = ref<DrawerView>('root');

// Root nav state
const activeCategory = ref(library[0]?.category ?? 'trigger');
const activeItems = computed(
  () => library.find(g => g.category === activeCategory.value)?.items ?? [],
);

// Integration nav state
const integrationCategories = INTEGRATION_CATEGORIES;
const activeIntegrationCategory = ref<string | null>(null);
const integrationItems = ref<Integration[]>([]);
const loadingIntegrations = ref(false);

function selectRootCategory(category: string) {
  activeCategory.value = category;
}

function openIntegrations() {
  view.value = 'integrations';
}

function closeIntegrations() {
  view.value = 'root';
  activeIntegrationCategory.value = null;
  integrationItems.value = [];
}

async function selectIntegrationCategory(cat: string) {
  activeIntegrationCategory.value = cat;
  loadingIntegrations.value = true;
  integrationItems.value = [];
  try {
    integrationItems.value = await loadIntegrationsFor(cat);
  } finally {
    loadingIntegrations.value = false;
  }
}

function initials(name: string): string {
  const words = name.split(/[\s\-]+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();

  return words[0].slice(0, 2).toUpperCase();
}

function onDragStart(event: DragEvent, item: RoutineLibraryItem) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('application/x-routine-subtype', item.subtype);
  event.dataTransfer.effectAllowed = 'copy';
}

function onIntegrationDragStart(event: DragEvent, integration: Integration) {
  if (!event.dataTransfer) return;
  event.dataTransfer.setData('application/x-routine-integration', JSON.stringify({
    id:          integration.id,
    name:        integration.name,
    category:    integration.category,
    description: integration.description,
  }));
  event.dataTransfer.effectAllowed = 'copy';
}
</script>

<style scoped>
.node-drawer {
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
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  --serif: "Iowan Old Style", "Palatino", Georgia, serif;

  position: absolute;
  top: 28px;
  bottom: 28px;
  left: 0;
  z-index: 10;
  width: 490px;
  background: linear-gradient(180deg, rgba(20, 30, 54, 0.92), rgba(14, 22, 40, 0.95));
  border: 1px solid rgba(168, 192, 220, 0.22);
  border-left: none;
  border-radius: 0 12px 12px 0;
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55), 0 0 30px rgba(139, 92, 246, 0.12);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  color: #e6ecf5;
  transform: translateX(-100%);
  opacity: 0;
  pointer-events: none;
  transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.25, 1), opacity 0.22s ease;
}
.node-drawer.open {
  transform: translateX(0);
  opacity: 1;
  pointer-events: auto;
}

.d-head {
  padding: 12px 14px 10px;
  border-bottom: 1px solid rgba(168, 192, 220, 0.14);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.d-head .title { display: flex; flex-direction: column; gap: 2px; }
.d-head .k {
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.3em;
  color: var(--violet-300);
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.d-head .k::before {
  content: '';
  width: 14px;
  height: 1px;
  background: var(--violet-400);
  display: inline-block;
}
.d-head .t {
  font-family: var(--serif);
  font-size: 15px;
  font-style: italic;
  color: white;
}
.d-head .close {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  display: grid;
  place-items: center;
  color: var(--steel-300);
  cursor: pointer;
  background: transparent;
  border: 1px solid rgba(168, 192, 220, 0.18);
  font-size: 12px;
  line-height: 1;
  padding: 0;
}
.d-head .close:hover {
  color: white;
  border-color: rgba(167, 139, 250, 0.5);
  background: rgba(139, 92, 246, 0.1);
}

.d-search {
  margin: 10px 12px 0;
  padding: 6px 10px;
  border-radius: 6px;
  background: rgba(10, 17, 31, 0.6);
  border: 1px solid rgba(168, 192, 220, 0.15);
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--steel-300);
  letter-spacing: 0.04em;
}
.d-search .placeholder { color: var(--steel-500); }
.d-search .sc {
  margin-left: auto;
  color: var(--steel-600);
  font-size: 9px;
  letter-spacing: 0.1em;
}

.d-split {
  display: flex;
  flex: 1;
  min-height: 0;
  padding: 10px;
  gap: 10px;
}

/* ── Left: sliding category nav ── */
.d-cats {
  width: 170px;
  flex-shrink: 0;
  position: relative;
  overflow: hidden;
}
.nav-page {
  display: flex;
  flex-direction: column;
  gap: 3px;
  height: 100%;
  overflow-y: auto;
}
.cat {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 12px;
  border-radius: 7px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--steel-200);
  font-family: inherit;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
  cursor: pointer;
  text-align: left;
  flex-shrink: 0;
}
.cat .cnt {
  font-family: var(--mono);
  font-size: 9.5px;
  color: var(--steel-500);
  letter-spacing: 0.08em;
  font-weight: 500;
}
.cat:hover {
  background: rgba(139, 92, 246, 0.06);
  border-color: rgba(167, 139, 250, 0.15);
  color: white;
}
.cat.active {
  background: linear-gradient(90deg, rgba(139, 92, 246, 0.22), rgba(139, 92, 246, 0.08));
  border-color: rgba(167, 139, 250, 0.55);
  color: white;
  box-shadow: inset 0 0 14px rgba(139, 92, 246, 0.12);
}
.cat.active .cnt { color: var(--violet-300); }

.cat-special .arr,
.cat-back .arr {
  color: var(--violet-300);
  font-size: 14px;
  font-weight: 400;
}
.cat-special:hover .arr { color: white; }
.cat-back {
  color: var(--violet-300);
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  font-size: 10px;
}
.cat-back .arr {
  margin-right: 6px;
}
.cat-back:hover {
  color: white;
  background: rgba(139, 92, 246, 0.12);
  border-color: rgba(167, 139, 250, 0.35);
}

.cat-divider {
  height: 1px;
  background: rgba(168, 192, 220, 0.12);
  margin: 4px 2px;
  flex-shrink: 0;
}

/* Slide transition between the two nav pages */
.slide-nav-enter-active,
.slide-nav-leave-active {
  transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.25, 1), opacity 0.2s ease;
}
.slide-nav-enter-from {
  transform: translateX(30px);
  opacity: 0;
}
.slide-nav-leave-to {
  transform: translateX(-30px);
  opacity: 0;
}

/* ── Right: draggable preview cards ── */
.d-cards {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  position: relative;
}
.cards-page {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 2px;
}

.fade-enter-active,
.fade-leave-active { transition: opacity 0.18s ease; }
.fade-enter-from,
.fade-leave-to { opacity: 0; }

.empty-hint {
  padding: 30px 16px;
  text-align: center;
  font-family: var(--mono);
  font-size: 10.5px;
  letter-spacing: 0.12em;
  color: var(--steel-400);
  text-transform: uppercase;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.empty-hint .ico {
  font-size: 20px;
  color: var(--violet-400);
  opacity: 0.5;
}

.drag-card {
  position: relative;
  display: flex;
  border-radius: 10px;
  overflow: hidden;
  background: linear-gradient(135deg, rgba(24, 36, 62, 0.95), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.14);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  cursor: grab;
  transition: transform 0.12s ease, border-color 0.15s ease, box-shadow 0.15s ease;
  flex-shrink: 0;
}
.drag-card:hover {
  border-color: rgba(167, 139, 250, 0.55);
  box-shadow: 0 0 0 1px rgba(167, 139, 250, 0.15), 0 0 24px rgba(139, 92, 246, 0.2), 0 6px 18px rgba(0, 0, 0, 0.4);
  transform: translateY(-1px);
}
.drag-card:active {
  cursor: grabbing;
  transform: scale(0.98);
}

/* ── Loop drawer preview ──
   Mini version of LoopFrameNode so the drawer shows the user what's
   actually going to land on the canvas — dashed violet frame, label
   pill, counter pill, hint text. Dimensions shrink-to-fit the drawer's
   card column; the real frame gets sized at drop time. */
.drag-card-loop {
  background: transparent;
  border: none;
  box-shadow: none;
  padding: 18px 8px 8px;
  min-height: 110px;
}
.drag-card-loop:hover {
  background: transparent;
  border: none;
  box-shadow: none;
  transform: translateY(-1px);
}
.drag-card-loop .loop-preview {
  position: relative;
  width: 100%;
  min-height: 92px;
  padding: 20px 14px 14px;
  border-radius: 10px;
  border: 1.5px dashed rgba(167, 139, 250, 0.65);
  background: rgba(52, 40, 90, 0.25);
  box-shadow: inset 0 0 24px rgba(139, 92, 246, 0.12);
  box-sizing: border-box;
}
.drag-card-loop:hover .loop-preview {
  border-color: rgba(196, 181, 253, 0.85);
  background: rgba(58, 42, 100, 0.32);
  box-shadow: inset 0 0 32px rgba(139, 92, 246, 0.22), 0 0 20px rgba(139, 92, 246, 0.2);
}
.drag-card-loop .loop-preview-label {
  position: absolute;
  top: -10px;
  left: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  background: linear-gradient(135deg, var(--violet-500), var(--violet-600));
  border: 1px solid rgba(196, 181, 253, 0.5);
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.16em;
  color: white;
  text-transform: uppercase;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  white-space: nowrap;
}
.drag-card-loop .loop-preview-label .ic {
  font-size: 10px;
  line-height: 1;
}
.drag-card-loop .loop-preview-counter {
  position: absolute;
  top: -10px;
  right: 12px;
  padding: 3px 8px;
  border-radius: 4px;
  background: rgba(28, 20, 50, 0.95);
  border: 1px solid rgba(167, 139, 250, 0.4);
  font-family: var(--mono);
  font-size: 8.5px;
  letter-spacing: 0.1em;
  color: var(--violet-300);
  text-transform: uppercase;
}
.drag-card-loop .loop-preview-hint {
  font-family: var(--serif);
  font-size: 11px;
  font-style: italic;
  color: var(--violet-200);
  text-align: center;
  line-height: 1.4;
  opacity: 0.75;
}

.drag-card .stub {
  width: 52px;
  padding: 10px 4px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  border-right: 2px dashed rgba(168, 192, 220, 0.28);
  text-align: center;
  flex-shrink: 0;
}
.drag-card:hover .stub { border-right-color: rgba(167, 139, 250, 0.45); }
.drag-card .stub .no {
  font-family: var(--mono);
  font-size: 9px;
  color: var(--steel-400);
  letter-spacing: 0.15em;
  text-transform: uppercase;
}
.drag-card .stub .av {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  margin: 5px 0 4px;
  display: grid;
  place-items: center;
  color: white;
  font-weight: 800;
  font-size: 10px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
}
.drag-card .stub .av.trigger { background: linear-gradient(135deg, var(--amber-400), var(--amber-600)); }
.drag-card .stub .av.agent   { background: linear-gradient(135deg, var(--steel-400), var(--steel-700)); }
.drag-card .stub .av.tool    { background: linear-gradient(135deg, var(--teal-400), var(--teal-600)); }
.drag-card .stub .av.logic   { background: linear-gradient(135deg, #94a3b8, #475569); }
.drag-card .stub .av.loop    { background: linear-gradient(135deg, #8fb3d9, var(--steel-600)); }
.drag-card .stub .av.default { background: linear-gradient(135deg, var(--steel-400), var(--steel-700)); }
.drag-card .stub .st {
  font-family: var(--mono);
  font-size: 7.5px;
  letter-spacing: 0.18em;
  color: var(--steel-300);
  text-transform: uppercase;
}

.drag-card .body {
  flex: 1;
  padding: 9px 30px 9px 10px;
  min-width: 0;
}
.drag-card .body .k {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.16em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.drag-card:hover .body .k { color: var(--violet-300); }
.drag-card .body .t {
  font-family: var(--serif);
  font-size: 13.5px;
  font-style: italic;
  color: white;
  line-height: 1.15;
  margin-top: 2px;
}
.drag-card .body .r {
  font-size: 10px;
  color: var(--steel-200);
  opacity: 0.85;
  margin-top: 3px;
}
.drag-card .body .q {
  margin-top: 6px;
  padding-left: 7px;
  border-left: 2px solid var(--steel-400);
  font-family: var(--serif);
  font-size: 10.5px;
  font-style: italic;
  color: #b5ccdf;
  line-height: 1.35;
}
.drag-card:hover .body .q {
  border-left-color: var(--violet-400);
  color: var(--violet-300);
}

.drag-card .grab-hint {
  position: absolute;
  top: 6px;
  right: 9px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--steel-500);
  letter-spacing: 0.05em;
  opacity: 0.55;
}
.drag-card:hover .grab-hint {
  color: var(--violet-300);
  opacity: 1;
}

.d-foot {
  display: flex;
  gap: 8px;
  justify-content: space-between;
  padding: 8px 12px;
  border-top: 1px solid rgba(168, 192, 220, 0.14);
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.d-foot .tip { color: var(--steel-300); }
.d-foot .tip b {
  color: var(--violet-300);
  font-weight: 700;
}
</style>
