<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/**
 * One ordered provider list (Agents or Subconscious agents): drag, keyboard
 * and button reorder, a class per row with the model it resolves to, live
 * status chips, skip toggles, remove, and the Add provider picker.
 */
import { computed, nextTick, onBeforeUnmount, ref } from 'vue';

import PrefToggle from '../../PrefToggle.vue';
import RoutingIcon from './RoutingIcon.vue';
import { animateIn, animateOut, flip, nudge, placePopover, rowByKey, startDrag } from './routingDom';
import {
  addRowGroups, availability, CLASS_LABELS, classOptions, findProvider, modelName, providerChip, providerKind, providerLetter, providerName,
  resolvedModel, rowChip, rowKey, shortModelName, timeLeft, type RoutingListKey,
} from './routingLogic';
import type { ModelClass, ModelRoutingState, RoutingRow } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { openMainTab } from '@pkg/composables/preferences/openInMain';

const props = defineProps<{
  listKey:    RoutingListKey;
  title:      string;
  subtitle:   string;
  resetLabel: string;
  footHint:   string;
  state:      ModelRoutingState;
  rows:       RoutingRow[];
  now:        number;
  /** Who uses this list, shown as chips under the header. */
  who?:       string[];
  /** Show the "Not connected" providers and the one-provider hint (Agents card only). */
  connections?: boolean;
}>();
const emit = defineEmits<{ (e: 'update', rows: RoutingRow[]): void; (e: 'reset'): void; (e: 'toast', message: string): void }>();

const ROW = '.mr-prow';
const root = ref<HTMLElement | null>(null);
const listEl = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const addBtn = ref<HTMLButtonElement | null>(null);
const picking = ref(false);
const offOpen = ref(false);

const listName = computed(() => props.listKey === 'agents' ? 'Agents' : 'Subconscious');
const connected = computed(() => props.state.providers.filter(p => p.connected));
const disconnected = computed(() => props.state.providers.filter(p => !p.connected));
const offShown = computed(() => offOpen.value ? disconnected.value : disconnected.value.slice(0, 5));
const groups = computed(() => addRowGroups(props.state, props.rows));

function label(row: RoutingRow) { return `${ providerName(props.state, row.provider) } · ${ CLASS_LABELS[row.class] }`; }
function resolvedName(row: RoutingRow) { const m = resolvedModel(props.state, row); return m ? shortModelName(modelName(props.state, m.provider, m.model)) : ''; }
function resolvedTitle(row: RoutingRow) {
  const m = resolvedModel(props.state, row);
  return m ? `${ modelName(props.state, m.provider, m.model) } (${ m.model })` : `No model in this class for ${ providerName(props.state, row.provider) }`;
}
type Subline = { kind: 'cool' | 'err' | 'off' | 'text'; text: string };
function subline(row: RoutingRow): Subline {
  const p = findProvider(props.state, row.provider); const a = availability(props.state, row.provider, props.now);
  if (a.kind === 'cool') return { kind: 'cool', text: `Usage limit hit · resets in ${ timeLeft(p?.coolingUntil, props.now) }` };
  if (a.kind === 'err') return { kind: 'err', text: a.why ?? 'Error' };
  if (a.kind === 'off' && !p?.connected) return { kind: 'off', text: 'Not connected' };
  if (props.listKey === 'subconscious' && p?.subscription) return { kind: 'text', text: row.enabled ? 'Shares usage limits with your main agents' : 'Off by default · shares usage limits with Agents' };
  return { kind: 'text', text: providerKind(props.state, row.provider) };
}

function commit(rows: RoutingRow[]) { return flip(listEl.value, ROW, () => emit('update', rows)); }
function focusIn(key: string, selector: string) { rowByKey(listEl.value, ROW, key)?.querySelector<HTMLElement>(selector)?.focus({ preventScroll: true }); }

async function move(i: number, delta: number, from: 'grip' | 'button') {
  const j = i + delta;
  if (j < 0 || j >= props.rows.length) return;
  const key = rowKey(props.rows[i]); const next = [...props.rows]; const [r] = next.splice(i, 1); next.splice(j, 0, r);
  await commit(next);
  const el = rowByKey(listEl.value, ROW, key);
  (from === 'grip' ? el?.querySelector<HTMLElement>('.mr-grip') : (el?.querySelector<HTMLElement>(`[data-mv="${ delta }"]:not(:disabled)`) ?? el?.querySelector<HTMLElement>('.mr-grip')))?.focus();
}
function onDrag(e: PointerEvent) {
  if (!listEl.value) return;
  startDrag(e, { list: listEl.value, selector: ROW, onDrop: (from, to) => { const next = [...props.rows]; const [r] = next.splice(from, 1); next.splice(to, 0, r); emit('update', next); } });
}
async function remove(i: number) {
  const row = props.rows[i];
  await animateOut(rowByKey(listEl.value, ROW, rowKey(row)));
  await commit(props.rows.filter((_, n) => n !== i));
  const rms = listEl.value?.querySelectorAll<HTMLElement>('.mr-rm');
  (rms?.[Math.min(i, rms.length - 1)] ?? addBtn.value)?.focus({ preventScroll: true });
  const name = providerName(props.state, row.provider);
  emit('toast', `Removed ${ name } · ${ CLASS_LABELS[row.class] } from ${ listName.value }. ${ name } stays connected.`);
}
function toggle(i: number, enabled: boolean) { emit('update', props.rows.map((r, n) => n === i ? { ...r, enabled } : r)); }
async function setClass(i: number, value: string) {
  const modelClass = value as ModelClass; const row = { ...props.rows[i], class: modelClass };
  emit('update', props.rows.map((r, n) => n === i ? row : r));
  await nextTick();
  const el = rowByKey(listEl.value, ROW, rowKey(row));
  nudge(el?.querySelector<HTMLElement>('.mr-res')); el?.querySelector<HTMLElement>('select')?.focus();
  if (!resolvedModel(props.state, row)) emit('toast', `${ providerName(props.state, row.provider) } has no ${ CLASS_LABELS[modelClass] } model yet. Add one under Models in each class, or this row is skipped.`);
}

// Add provider picker
function onOutside(e: PointerEvent) { const t = e.target as Node; if (!pop.value?.contains(t) && !addBtn.value?.contains(t)) closePicker(); }
async function openPicker() {
  if (picking.value) return closePicker(true);
  picking.value = true;
  await nextTick();
  if (pop.value && addBtn.value && root.value) placePopover(pop.value, addBtn.value, root.value);
  (pop.value?.querySelector<HTMLElement>('.mr-pi:not(:disabled)') ?? pop.value)?.focus();
  document.addEventListener('pointerdown', onOutside, true);
}
function closePicker(refocus = false) {
  if (!picking.value) return;
  picking.value = false;
  document.removeEventListener('pointerdown', onOutside, true);
  if (refocus) addBtn.value?.focus({ preventScroll: true });
}
async function add(provider: string, modelClass: ModelClass) {
  closePicker();
  const row: RoutingRow = { provider, class: modelClass, enabled: true };
  await commit([...props.rows, row]);
  const el = rowByKey(listEl.value, ROW, rowKey(row));
  animateIn(el); focusIn(rowKey(row), '.mr-grip');
}
function chipNoTime(provider: string) { const c = providerChip(props.state, provider, props.now); return { ...c, label: c.label.replace(/ until .+$/, '') }; }
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true));
</script>

<template>
  <section
    ref="root"
    class="card mr-card"
    :class="{ picking: picking }"
    :aria-label="title"
  >
    <div class="card-h">
      <div>
        <h2>{{ title }}</h2>
        <p>{{ subtitle }}</p>
      </div>
      <div class="r">
        <button
          type="button"
          class="link mr-link"
          @click="emit('reset')"
        >
          {{ resetLabel }}
        </button>
      </div>
    </div>
    <div
      v-if="who?.length"
      class="mr-who"
      aria-label="Uses this list"
    >
      <span
        v-for="w in who"
        :key="w"
      >{{ w }}</span>
    </div>
    <ol
      ref="listEl"
      class="mr-plist"
      :aria-label="`${ title }: providers and model classes, in the order Sulla tries them`"
    >
      <li
        v-for="(row, i) in rows"
        :key="rowKey(row)"
        :data-key="rowKey(row)"
        class="mr-prow"
        :class="{ skip: !row.enabled }"
      >
        <button
          type="button"
          class="mr-grip"
          :aria-label="`Drag to reorder ${ label(row) }. Use the up and down arrow keys to move it.`"
          title="Drag to reorder"
          @pointerdown="onDrag"
          @keydown.up.prevent="move(i, -1, 'grip')"
          @keydown.down.prevent="move(i, 1, 'grip')"
        >
          <RoutingIcon name="grip" />
        </button>
        <span class="mr-rank">{{ i + 1 }}</span>
        <span
          class="mr-logo"
          aria-hidden="true"
        >{{ providerLetter(state, row.provider) }}</span>
        <span class="mr-pname">
          <b>{{ providerName(state, row.provider) }}</b>
          <small>
            <span
              v-if="subline(row).kind === 'cool'"
              class="mr-cd"
            >{{ subline(row).text }}</span>
            <span
              v-else-if="subline(row).kind === 'err'"
              class="mr-er"
            >{{ subline(row).text }} · <button
              type="button"
              class="link mr-inline-link"
              @click="openMainTab('integrations')"
            >Fix in Integrations</button></span>
            <span v-else-if="subline(row).kind === 'off'">Not connected · <button
              type="button"
              class="link mr-inline-link"
              @click="openMainTab('integrations')"
            >Connect</button></span>
            <template v-else>{{ subline(row).text }}</template>
          </small>
        </span>
        <span class="mr-cls">
          <select
            class="sel mr-sel-sm"
            :value="row.class"
            :aria-label="`Model class for ${ providerName(state, row.provider) }, row ${ i + 1 }`"
            @change="setClass(i, ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="o in classOptions(state, rows, row)"
              :key="o.value"
              :value="o.value"
              :disabled="o.disabled"
            >{{ o.label }}</option>
          </select>
          <span
            class="mr-res"
            :class="{ none: !resolvedName(row) }"
            :title="resolvedTitle(row)"
          >→ <b v-if="resolvedName(row)">{{ resolvedName(row) }}</b><template v-else>no model</template></span>
        </span>
        <span
          class="mr-chip"
          :class="rowChip(state, row, now).kind"
        ><i />{{ rowChip(state, row, now).label }}</span>
        <span class="mr-moves">
          <button
            type="button"
            class="mr-ib"
            data-mv="-1"
            :aria-label="`Move ${ label(row) } up`"
            :disabled="i === 0"
            @click="move(i, -1, 'button')"
          ><RoutingIcon name="up" /></button>
          <button
            type="button"
            class="mr-ib"
            data-mv="1"
            :aria-label="`Move ${ label(row) } down`"
            :disabled="i === rows.length - 1"
            @click="move(i, 1, 'button')"
          ><RoutingIcon name="down" /></button>
          <button
            type="button"
            class="mr-ib mr-rm"
            :aria-label="`Remove ${ label(row) } from ${ listName }`"
            title="Remove from this list"
            @click="remove(i)"
          ><RoutingIcon name="x" /></button>
        </span>
        <PrefToggle
          :model-value="row.enabled"
          :label="`Use ${ label(row) }`"
          :title="row.enabled ? 'Turn off to skip without removing' : 'Skipped. Turn on to use it again.'"
          @update:model-value="toggle(i, $event)"
        />
      </li>
      <li
        v-if="!rows.length"
        class="mr-lempty"
      >
        <RoutingIcon name="info" />
        <span>{{ listKey === 'agents' ? 'No providers. Main agents can’t run until you add one.' : 'No providers. Background agents pause until you add one.' }}</span>
      </li>
    </ol>
    <div class="mr-lfoot">
      <button
        ref="addBtn"
        type="button"
        class="btn sm"
        aria-haspopup="dialog"
        :aria-expanded="picking"
        @click="openPicker"
      >
        <RoutingIcon name="plus" />Add provider
      </button>
      <small>{{ footHint }}</small>
    </div>

    <template v-if="connections">
      <div
        v-if="connected.length === 1"
        class="mr-hint"
      >
        <RoutingIcon name="info" />
        <span><b>Connect another provider</b> so Sulla can keep working when {{ providerName(state, connected[0].id) }} hits its limit, and so background agents don’t share its usage.</span>
        <button
          type="button"
          class="btn sm pri"
          @click="openMainTab('integrations')"
        >
          <RoutingIcon name="plus" />Connect a provider
        </button>
      </div>
      <template v-if="disconnected.length">
        <div class="mr-sub">
          <span>Not connected</span>
          <span class="r"><button
            type="button"
            class="link mr-link"
            @click="openMainTab('integrations')"
          >Open Integrations</button></span>
        </div>
        <ul class="mr-offlist">
          <li
            v-for="p in offShown"
            :key="p.id"
            class="mr-offrow"
          >
            <span
              class="mr-logo"
              aria-hidden="true"
            >{{ providerLetter(state, p.id) }}</span>
            <span class="mr-pname"><b>{{ providerName(state, p.id) }}</b></span>
            <button
              type="button"
              class="link mr-link"
              @click="openMainTab('integrations')"
            >
              Connect
            </button>
          </li>
        </ul>
        <button
          v-if="disconnected.length > 5"
          type="button"
          class="more mr-offmore"
          :class="{ open: offOpen }"
          :aria-expanded="offOpen"
          @click="offOpen = !offOpen"
        >
          <RoutingIcon name="chev" />{{ offOpen ? 'Show fewer' : `Show ${ disconnected.length - 5 } more providers` }}
        </button>
      </template>
    </template>

    <div
      v-if="picking"
      ref="pop"
      class="mr-picker"
      role="dialog"
      tabindex="-1"
      :aria-label="`Add a provider to ${ listName }`"
      @keydown.esc.stop.prevent="closePicker(true)"
    >
      <div class="mr-pk-h">
        <b>Add to {{ listName }}</b>
        <small>Pick a connected provider and the class to use from it.</small>
      </div>
      <div class="mr-pk-b">
        <div
          v-for="g in groups"
          :key="g.provider.id"
          class="mr-pg"
          role="group"
          :aria-label="providerName(state, g.provider.id)"
        >
          <div class="mr-pgh">
            <span
              class="mr-logo"
              aria-hidden="true"
            >{{ providerLetter(state, g.provider.id) }}</span>
            <b>{{ providerName(state, g.provider.id) }}</b>
            <span
              class="mr-chip"
              :class="chipNoTime(g.provider.id).kind"
            ><i />{{ chipNoTime(g.provider.id).label }}</span>
          </div>
          <button
            v-for="c in g.classes"
            :key="c.value"
            type="button"
            class="mr-pi"
            :disabled="c.inList"
            @click="add(g.provider.id, c.value)"
          >
            <span>{{ CLASS_LABELS[c.value] }}</span>
            <code v-if="c.inList"><RoutingIcon name="check" />In list</code>
            <small v-else-if="c.model">→ {{ shortModelName(modelName(state, c.model.provider, c.model.model)) }}</small>
          </button>
        </div>
        <div
          v-if="!groups.length"
          class="mr-pk-none"
        >
          Connect a provider to add it here.
        </div>
      </div>
    </div>
  </section>
</template>
