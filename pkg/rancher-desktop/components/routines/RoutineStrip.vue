<template>
  <div
    class="strip"
    :class="{ featured: routine.featured }"
    @click="$emit('open')"
  >
    <div
      class="icon"
      :class="routine.category"
    >
      {{ routine.initials }}
    </div>

    <div class="body">
      <div class="top">
        <span class="cat">{{ routine.categoryLabel }}</span>
        <span
          v-if="statusChip"
          class="chip"
          :class="statusChip.cls"
        >
          <span
            v-if="statusChip.pulse"
            class="d"
          />
          {{ statusChip.label }}
        </span>
        <span
          v-if="routine.featured"
          class="chip violet"
        >Featured</span>
      </div>
      <div class="title">
        {{ routine.name }}
      </div>
      <div class="desc">
        {{ routine.description }}
      </div>
      <div class="meta">
        <span class="chip">{{ routine.agents }} agents</span>
        <span
          v-for="i in routine.integrations"
          :key="i"
          class="chip"
        >{{ i }}</span>
      </div>
    </div>

    <div class="metrics">
      <div class="big">
        <template v-if="routine.avgCycle">
          {{ routine.avgCycle }}<small v-if="routine.avgCycleUnit">{{ routine.avgCycleUnit }}</small>
        </template>
        <template v-else>
          —
        </template>
      </div>
      <div class="row">
        <span v-if="routine.runsPerWeek"><b>{{ routine.runsPerWeek }}</b> runs</span>
        <span v-else>not yet run</span>
        <span v-if="routine.costPerRun"><b>${{ routine.costPerRun }}</b>/run</span>
      </div>
      <div class="row">
        <span>{{ timingLabel }}</span>
      </div>
    </div>

    <div
      class="cta"
      @click.stop
    >
      <button
        type="button"
        class="btn primary"
        @click="$emit('primary')"
      >
        {{ primaryLabel }}
      </button>
      <div class="cta-row">
        <button
          type="button"
          class="btn ghost"
          @click="$emit('secondary')"
        >
          {{ secondaryLabel }}
        </button>
        <div
          class="menu-wrap"
          @click.stop
        >
          <button
            type="button"
            class="btn kebab"
            :class="{ on: menuOpen }"
            :aria-label="`Actions for ${ routine.name }`"
            @click="toggleMenu"
          >
            ⋮
          </button>
          <div
            v-if="menuOpen"
            class="menu"
            role="menu"
          >
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              @click="emitAction('duplicate')"
            >
              Duplicate
            </button>
            <button
              type="button"
              class="menu-item"
              role="menuitem"
              @click="emitAction('archive')"
            >
              {{ routine.status === 'archive' ? 'Unarchive' : 'Archive' }}
            </button>
            <div class="menu-sep" />
            <button
              type="button"
              class="menu-item danger"
              role="menuitem"
              @click="emitAction('delete')"
            >
              Delete…
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';

import type { RoutineSummary } from '@pkg/types/routines';

interface StatusChip {
  label: string;
  cls:   string;
  pulse: boolean;
}

const props = defineProps<{
  routine:        RoutineSummary;
  primaryLabel:   string;
  secondaryLabel: string;
}>();

const emit = defineEmits<{
  (e: 'open'): void;
  (e: 'primary'): void;
  (e: 'secondary'): void;
  (e: 'duplicate'): void;
  (e: 'archive'): void;
  (e: 'delete'): void;
}>();

// ── Actions kebab menu ──
// Lightweight dropdown: opens on click, closes on outside-click or after
// any menu item fires. A single document-level listener is attached only
// while the menu is open — no extra state, no full modal.
const menuOpen = ref(false);

function toggleMenu() {
  if (menuOpen.value) {
    closeMenu();

    return;
  }
  menuOpen.value = true;
  // Defer binding until after the click that opened the menu bubbles out,
  // otherwise that same click would immediately close it again.
  setTimeout(() => {
    document.addEventListener('click', onDocClick, { once: true });
  }, 0);
}

function closeMenu() {
  menuOpen.value = false;
  document.removeEventListener('click', onDocClick);
}

function onDocClick() {
  closeMenu();
}

function emitAction(action: 'duplicate' | 'archive' | 'delete') {
  closeMenu();
  emit(action);
}

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick);
});

// Status chip styling is a view concern — compute it from the
// domain model rather than making the template do the mapping.
const statusChip = computed<StatusChip | null>(() => {
  switch (props.routine.status) {
  case 'running':
    return { label: 'Live', cls: 'live', pulse: true };
  case 'scheduled':
    return { label: props.routine.schedule || 'Scheduled', cls: 'warn', pulse: false };
  case 'draft':
    return { label: 'Draft', cls: 'blue', pulse: false };
  case 'archive':
    return { label: 'Archived', cls: '', pulse: false };
  case 'idle':
    return { label: 'Idle', cls: '', pulse: false };
  default:
    return null;
  }
});

const timingLabel = computed(() => {
  const r = props.routine;
  if (r.status === 'running' && r.lastRunAgo) return `started ${ r.lastRunAgo } ago`;
  if (r.status === 'scheduled' && r.nextIn) return `next in ${ r.nextIn }`;
  if (r.lastRunAgo) return `last ${ r.lastRunAgo } ago`;

  return r.statusLabel.toLowerCase();
});
</script>

<style scoped lang="scss">
.strip {
  display: grid;
  grid-template-columns: 64px 1fr 170px auto;
  gap: 24px;
  align-items: center;
  padding: 22px 24px;
  background: linear-gradient(90deg, rgba(20, 30, 54, 0.6), rgba(11, 20, 40, 0.35));
  border: 1px solid var(--line);
  border-radius: 6px;
  margin-bottom: 12px;
  position: relative;
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s;
}
.strip:hover {
  border-color: rgba(140, 172, 201, 0.5);
  background: linear-gradient(90deg, rgba(30, 44, 74, 0.78), rgba(20, 28, 50, 0.5));
}
.strip::before {
  content: '';
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: linear-gradient(180deg, transparent, var(--steel-300), transparent);
  opacity: 0;
  transition: opacity 0.18s;
}
.strip:hover::before { opacity: 0.8; }
.strip.featured {
  border-color: rgba(167, 139, 250, 0.35);
  background: linear-gradient(90deg, rgba(44, 30, 82, 0.5), rgba(20, 30, 54, 0.5));
}
.strip.featured::before {
  opacity: 1;
  background: linear-gradient(180deg, transparent, var(--violet-400), transparent);
}

.icon {
  width: 56px; height: 56px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  color: white;
  font-family: var(--mono);
  font-weight: 700;
  font-size: 14px;
  border: 1px solid rgba(255, 255, 255, 0.12);
}
.icon.content  { background: linear-gradient(135deg, #2c4871, #4a6fa5); }
.icon.research { background: linear-gradient(135deg, #0891b2, #06b6d4); }
.icon.planning { background: linear-gradient(135deg, #d97706, #f59e0b); }
.icon.leads    { background: linear-gradient(135deg, #059669, #10b981); }
.icon.learning { background: linear-gradient(135deg, #7c3aed, #a78bfa); }
.icon.ops      { background: linear-gradient(135deg, #475569, #64748b); }
.icon.goals    { background: linear-gradient(135deg, #be123c, #e11d48); }

.body { min-width: 0; }
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.cat {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.22em;
  color: var(--steel-400);
  text-transform: uppercase;
}
.title {
  font-family: var(--serif);
  font-style: italic;
  font-size: 21px;
  color: white;
  line-height: 1.15;
  margin-bottom: 4px;
}
.desc {
  font-family: var(--sans);
  font-size: 12.5px;
  color: var(--steel-200);
  line-height: 1.5;
  margin-bottom: 10px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.meta {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}

.chip {
  font-family: var(--mono);
  font-size: 9px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  padding: 3px 8px;
  border-radius: 3px;
  border: 1px solid rgba(168, 192, 220, 0.22);
  color: var(--steel-200);
  background: rgba(20, 30, 54, 0.4);
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.chip.violet {
  border-color: rgba(167, 139, 250, 0.4);
  color: var(--violet-200);
  background: rgba(139, 92, 246, 0.14);
}
.chip.blue {
  border-color: rgba(116, 158, 214, 0.42);
  color: #b4d0f0;
  background: rgba(74, 111, 165, 0.2);
}
.chip.warn {
  border-color: rgba(245, 158, 11, 0.4);
  color: #fcd34d;
  background: rgba(245, 158, 11, 0.14);
}
.chip.live {
  border-color: rgba(244, 63, 94, 0.45);
  color: #fda4af;
  background: rgba(244, 63, 94, 0.16);
}
.chip.live .d {
  width: 5px; height: 5px;
  border-radius: 50%;
  background: #fb7185;
  animation: pulse-v 1.2s infinite;
}
@keyframes pulse-v { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

.metrics {
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: right;
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--steel-300);
  border-left: 1px solid var(--line);
  padding-left: 18px;
}
.metrics .big {
  font-family: var(--serif);
  font-style: italic;
  font-size: 22px;
  color: white;
  line-height: 1;
}
.metrics .big small {
  font-family: var(--mono);
  font-style: normal;
  font-size: 10px;
  color: var(--steel-400);
  margin-left: 3px;
}
.metrics .row {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}
.metrics .row span b {
  color: white;
  font-weight: 700;
}

.cta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: flex-end;
}
.cta-row {
  display: flex;
  gap: 4px;
  align-items: center;
}

// Kebab + dropdown for secondary actions (duplicate / archive / delete).
.menu-wrap { position: relative; }
.btn.kebab {
  padding: 6px 10px;
  font-size: 14px;
  letter-spacing: 0;
  line-height: 1;
  color: var(--steel-200);
}
.btn.kebab:hover,
.btn.kebab.on {
  color: white;
  background: rgba(74, 111, 165, 0.28);
  border-color: rgba(140, 172, 201, 0.5);
}
.menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 160px;
  padding: 4px;
  background: linear-gradient(180deg, rgba(20, 30, 54, 0.96), rgba(14, 22, 40, 0.98));
  border: 1px solid rgba(168, 192, 220, 0.25);
  border-radius: 6px;
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55), 0 0 20px rgba(74, 111, 165, 0.15);
  backdrop-filter: blur(10px);
  display: flex;
  flex-direction: column;
}
.menu-item {
  appearance: none;
  background: transparent;
  border: none;
  text-align: left;
  padding: 7px 10px;
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 11px;
  letter-spacing: 0.08em;
  color: var(--steel-100);
  cursor: pointer;
  transition: background 0.12s, color 0.12s;
}
.menu-item:hover {
  background: rgba(167, 139, 250, 0.16);
  color: white;
}
.menu-item.danger {
  color: #fda4af;
}
.menu-item.danger:hover {
  background: rgba(244, 63, 94, 0.18);
  color: white;
}
.menu-sep {
  height: 1px;
  background: rgba(168, 192, 220, 0.14);
  margin: 4px 2px;
}

.btn {
  font-family: var(--mono);
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  padding: 7px 14px;
  border-radius: 4px;
  border: 1px solid rgba(168, 192, 220, 0.3);
  color: var(--steel-100);
  background: rgba(20, 30, 54, 0.55);
  cursor: pointer;
  transition: background 0.18s, border-color 0.18s, color 0.18s;
  backdrop-filter: blur(6px);
  white-space: nowrap;
}
.btn:hover {
  border-color: rgba(196, 212, 230, 0.6);
  color: white;
  background: rgba(74, 111, 165, 0.16);
}
.btn.primary {
  border-color: rgba(140, 172, 201, 0.6);
  color: white;
  background: linear-gradient(135deg, rgba(74, 111, 165, 0.72), rgba(44, 72, 113, 0.82));
  box-shadow: 0 8px 22px rgba(74, 111, 165, 0.38), 0 0 14px rgba(74, 111, 165, 0.22);
}
.btn.primary:hover {
  background: linear-gradient(135deg, rgba(90, 130, 185, 0.9), rgba(58, 90, 140, 0.9));
  border-color: rgba(196, 212, 230, 0.75);
}
.btn.ghost { background: transparent; }
</style>
