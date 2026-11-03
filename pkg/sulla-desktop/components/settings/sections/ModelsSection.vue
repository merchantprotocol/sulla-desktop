<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/**
 * Preferences → AI models. Approved mockup: Projects/sulla-desktop/mockups/model-routing.
 * Cards: Agents → Subconscious agents → Models in each class → How a request is routed → Request settings.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue';

import PrefMore from '../PrefMore.vue';
import PrefRow from '../PrefRow.vue';
import ModelClasses from './modelRouting/ModelClasses.vue';
import RouteTrace from './modelRouting/RouteTrace.vue';
import RoutingIcon from './modelRouting/RoutingIcon.vue';
import RoutingList from './modelRouting/RoutingList.vue';
import { applyFollowOrder, sameModels } from './modelRouting/routingLogic';
import { MODEL_CLASSES, MODEL_ROUTING_IPC, type ClassModel, type ModelClass, type ModelRoutingState, type RoutingProviderInfo, type RoutingRow } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { useSullaSetting } from '@pkg/composables/preferences/useSullaSetting';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

type Patch = Partial<Pick<ModelRoutingState, 'agentsList' | 'subconsciousList' | 'classes' | 'followProviderOrder'>>;

const state = ref<ModelRoutingState | null>(null);
const unavailable = ref(false);
const error = ref('');
const saved = ref(false);
const toastText = ref('');
const toastOn = ref(false);
const now = ref(Date.now());

const retries = useSullaSetting('remoteRetryCount', 3, 'number');
const timeout = useSullaSetting('remoteTimeoutSeconds', 60, 'number');

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let savedTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let clock: ReturnType<typeof setInterval> | undefined;
let pending: Patch = {};
let snapshot = '';

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
function flashSaved() { saved.value = true; clearTimeout(savedTimer); savedTimer = setTimeout(() => { saved.value = false; }, 1600); }
function toast(message: string) { toastText.value = message; toastOn.value = true; clearTimeout(toastTimer); toastTimer = setTimeout(() => { toastOn.value = false; }, 2800); }

async function load() {
  try {
    state.value = await ipcRenderer.invoke(MODEL_ROUTING_IPC.get);
    snapshot = JSON.stringify(state.value);
  } catch {
    unavailable.value = true;
  }
}

/** Changes apply instantly on screen; saves are batched (300 ms) and rolled back if the main process rejects them. */
function save(patch: Patch) {
  if (!state.value) return;
  error.value = '';
  pending = { ...pending, ...clone(patch) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async() => {
    const body = pending; pending = {};
    try {
      const next = await ipcRenderer.invoke(MODEL_ROUTING_IPC.set, body);
      if (!Object.keys(pending).length) state.value = next;
      snapshot = JSON.stringify(next);
      flashSaved();
    } catch (e) {
      state.value = JSON.parse(snapshot);
      error.value = e instanceof Error ? e.message : String(e);
    }
  }, 300);
}

function setList(key: 'agentsList' | 'subconsciousList', rows: RoutingRow[]) {
  if (!state.value) return;
  state.value[key] = rows;
  const patch: Patch = { [key]: rows };
  if (key === 'agentsList') {
    // Classes that follow provider order re-sort with the Agents list, so the saved order is the order Sulla tries.
    const classes = applyFollowOrder(state.value);
    if (MODEL_CLASSES.some(c => !sameModels(classes[c], state.value!.classes[c]))) { state.value.classes = classes; patch.classes = classes; }
  }
  save(patch);
}
function setClass(modelClass: ModelClass, models: ClassModel[], follow: boolean) {
  if (!state.value) return;
  state.value.classes[modelClass] = models;
  state.value.followProviderOrder[modelClass] = follow;
  save({ classes: state.value.classes, followProviderOrder: state.value.followProviderOrder });
}
async function reset(section: 'agents' | 'subconscious' | 'classes', modelClass?: ModelClass) {
  if (!state.value) return;
  error.value = '';
  try {
    state.value = await ipcRenderer.invoke(MODEL_ROUTING_IPC.reset, { section, class: modelClass });
    snapshot = JSON.stringify(state.value);
    flashSaved();
    toast(section === 'agents' ? 'Agents are back to the default: subscriptions first, then API keys, then on this Mac, each on its strongest class.'
      : section === 'subconscious' ? 'Subconscious is back to the default: on this Mac first, then the cheapest online providers, all on Fast.'
        : `${ modelClass ? modelClass[0].toUpperCase() + modelClass.slice(1) : 'Every class' } is back on the recommended models, in provider order.`);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
function onStatus(_: unknown, providers: RoutingProviderInfo[]) {
  if (state.value) state.value.providers = providers;
  now.value = Date.now();
}

function value(e: Event) { return (e.target as HTMLInputElement).value; }
async function saveNumber(setting: typeof retries, raw: string, min: number, max: number) {
  const n = Math.round(Number(raw));
  if (Number.isFinite(n) && n >= min && n <= max) { await setting.save(n); flashSaved(); } else await setting.reload();
}

onMounted(() => {
  void load();
  ipcRenderer.on(MODEL_ROUTING_IPC.status, onStatus);
  clock = setInterval(() => { now.value = Date.now(); }, 30_000);
});
onBeforeUnmount(() => {
  clearTimeout(saveTimer); clearTimeout(savedTimer); clearTimeout(toastTimer); clearInterval(clock);
  ipcRenderer.removeListener(MODEL_ROUTING_IPC.status, onStatus);
});
</script>

<template>
  <div class="mr-page">
    <div class="ph">
      <div>
        <h1>AI models</h1>
        <p>Which providers Sulla tries, in what order, and which class of model it uses from each.</p>
      </div>
      <span
        class="mr-saved"
        :class="{ show: saved }"
        role="status"
      ><RoutingIcon name="check" />Saved</span>
    </div>

    <div
      v-if="error"
      class="alert"
      role="alert"
    >
      <RoutingIcon name="alert" />
      <div class="x">
        <b>Couldn’t save model routing</b>
        <span>{{ error }} Your last saved settings are back on screen.</span>
      </div>
      <div class="r">
        <button
          type="button"
          class="btn sm"
          @click="error = ''"
        >
          Dismiss
        </button>
      </div>
    </div>

    <div
      v-if="unavailable"
      class="alert info"
    >
      <RoutingIcon name="info" />
      <div class="x">
        <b>Model routing needs the latest Sulla backend.</b>
        <span>Update Sulla, then come back here to set up your provider lists.</span>
      </div>
    </div>
    <div
      v-else-if="!state"
      class="loading"
    >
      Loading your provider lists…
    </div>
    <template v-else>
      <RoutingList
        list-key="agents"
        title="Agents"
        subtitle="Your main agents try these top to bottom, each on its own model class. Drag to reorder."
        reset-label="Reset to default order"
        foot-hint="Add a provider again on a cheaper class to use it as a fallback."
        :state="state"
        :rows="state.agentsList"
        :now="now"
        connections
        @update="setList('agentsList', $event)"
        @reset="reset('agents')"
        @toast="toast"
      />
      <RoutingList
        list-key="subconscious"
        title="Subconscious agents"
        subtitle="Background agents that read and organize your conversations. Keep these cheap and fast so they never compete with your main agents for usage limits."
        reset-label="Reset to default"
        foot-hint="On this Mac first, then the cheapest online providers."
        :who="['Memory curators', 'Observers', 'Background watchers', 'The Brain']"
        :state="state"
        :rows="state.subconsciousList"
        :now="now"
        @update="setList('subconsciousList', $event)"
        @reset="reset('subconscious')"
        @toast="toast"
      />
      <ModelClasses
        :state="state"
        :now="now"
        @change="setClass"
        @reset="reset('classes', $event)"
        @toast="toast"
      />
      <RouteTrace
        :state="state"
        :now="now"
      />
    </template>

    <section class="card mr-req">
      <PrefMore label="Request settings">
        <PrefRow
          title="Retries per provider"
          subtitle="How many times Sulla retries a failed request before moving to the next row."
        >
          <input
            class="inp sm mr-num"
            type="number"
            min="0"
            max="10"
            aria-label="Retries per provider"
            :value="retries.value.value"
            @change="saveNumber(retries, value($event), 0, 10)"
          >
        </PrefRow>
        <PrefRow
          title="Request timeout"
          subtitle="Seconds to wait for an answer before trying the next row."
        >
          <input
            class="inp sm mr-num"
            type="number"
            min="5"
            max="600"
            aria-label="Request timeout in seconds"
            :value="timeout.value.value"
            @change="saveNumber(timeout, value($event), 5, 600)"
          >
          <span class="dimc">sec</span>
        </PrefRow>
      </PrefMore>
    </section>

    <div
      class="mr-toast"
      :class="{ show: toastOn }"
      role="status"
    >
      {{ toastText }}
    </div>
  </div>
</template>

<style lang="scss">
/*
 * Model routing styles, ported from the approved mockup onto the Preferences
 * tokens (sulla-window.scss). Not scoped because the four routing components
 * share them; every class is mr- prefixed and nested under .mr-page.
 */
.mr-page {
  --ease-enter: cubic-bezier(.16, 1, .3, 1);
  --ease-std: cubic-bezier(.22, 1, .36, 1);
  --ease-exit: cubic-bezier(.7, 0, .84, 0);
  --t-instant: 120ms;
  --t-fast: 160ms;
  --t-std: 240ms;
  --t-move: 480ms;
  --ink-03: color-mix(in srgb, var(--text) 3%, transparent);
  --warn-ink: color-mix(in srgb, var(--warn) 70%, var(--text));

  button { cursor: pointer; }
  button:focus-visible, select:focus-visible, input:focus-visible {
    outline: 0;
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 28%, transparent);
  }
  .mr-i { display: inline-grid; place-items: center; width: 16px; height: 16px; flex: none; }
  .mr-i svg { display: block; width: 100%; height: 100%; }
  .btn .mr-i { width: 13px; height: 13px; }
  .alert > .mr-i { width: 18px; height: 18px; color: var(--bad); margin-top: 1px; }
  .alert.info > .mr-i { color: var(--accent-2); }

  /* Saved pill */
  .mr-saved {
    margin-left: auto; display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
    background: var(--ok-soft); color: var(--ok); font-size: 12px; font-weight: 600; opacity: 0; transform: translateY(4px);
    transition: opacity var(--t-fast) var(--ease-exit), transform var(--t-fast) var(--ease-exit);
  }
  .mr-saved.show { opacity: 1; transform: none; transition: opacity var(--t-std) var(--ease-enter), transform var(--t-std) var(--ease-enter); }
  .mr-saved .mr-i { width: 12px; height: 12px; }

  .mr-card { position: relative; }
  /* Cards are stacking contexts (backdrop-filter): lift the one with an open picker above the cards after it. */
  .mr-card.picking { z-index: 30; }
  .mr-link { font-size: 12.5px; }
  .mr-link[disabled] { color: var(--dim); text-decoration: none; cursor: default; }
  .mr-inline-link { font-size: 12px; color: inherit; text-decoration: underline; }

  /* Status chip */
  .mr-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px 2px 8px; border-radius: 999px; font-size: 11.5px;
    font-weight: 600; white-space: nowrap; background: var(--ok-soft); color: color-mix(in srgb, var(--ok) 80%, var(--text));
    transition: background var(--t-std) var(--ease-std), color var(--t-std) var(--ease-std);
  }
  .mr-chip i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; flex: none; }
  .mr-chip.cool { background: var(--warn-soft); color: var(--warn-ink); }
  .mr-chip.err { background: var(--bad-soft); color: var(--bad); }
  .mr-chip.off { background: var(--idle-soft); color: var(--muted); }

  /* Shared row parts */
  .mr-grip {
    width: 20px; height: 28px; display: grid; place-items: center; border: 0; background: none; padding: 0; color: var(--dim);
    cursor: grab; border-radius: 6px; touch-action: none;
  }
  .mr-grip:hover { color: var(--text); background: var(--ink-05); }
  .mr-grip .mr-i { width: 14px; height: 14px; }
  .mr-rank { font-size: 11.5px; font-weight: 600; color: var(--dim); text-align: center; font-variant-numeric: tabular-nums; }
  .mr-logo {
    width: 28px; height: 28px; border-radius: 8px; display: grid; place-items: center; background: var(--card-solid);
    box-shadow: inset 0 0 0 1px var(--line-2); font-weight: 650; font-size: 12px; color: var(--text); flex: none;
  }
  .mr-pname { min-width: 0; }
  .mr-pname b { display: block; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mr-pname small { display: block; color: var(--dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mr-cd { color: var(--warn-ink); }
  .mr-er { color: var(--bad); }
  .mr-moves { display: flex; gap: 2px; }
  .mr-ib {
    width: 24px; height: 24px; display: grid; place-items: center; border: 0; border-radius: 6px; background: none; color: var(--muted);
    padding: 0; transition: background var(--t-instant) var(--ease-std), transform var(--t-instant) var(--ease-std);
  }
  .mr-ib:hover { background: var(--ink-05); color: var(--text); }
  .mr-ib:active { transform: scale(.92); }
  .mr-ib:disabled { opacity: .3; pointer-events: none; }
  .mr-ib .mr-i { width: 14px; height: 14px; }
  .mr-rm:hover { color: var(--bad); background: var(--bad-soft); }

  /* Provider lists */
  .mr-who { display: flex; flex-wrap: wrap; gap: 6px; padding: 10px 18px 2px; }
  .mr-who span { padding: 1px 8px; border-radius: 6px; background: var(--ink-05); color: var(--muted); font-size: 11.5px; font-weight: 500; }
  .mr-plist { list-style: none; margin: 0; padding: 6px 0; position: relative; }
  .mr-prow {
    display: grid; grid-template-columns: 20px 22px 28px minmax(0, 1fr) 222px 206px auto 34px; grid-template-areas: "g r l n c s m t";
    align-items: center; gap: 10px; padding: 9px 18px 9px 12px; position: relative; background: transparent;
    transition: background var(--t-instant) var(--ease-std), opacity var(--t-std) var(--ease-std);
  }
  .mr-prow + .mr-prow { box-shadow: inset 0 1px 0 var(--line); }
  .mr-prow:hover { background: var(--ink-03); }
  .mr-prow.skip .mr-pname, .mr-prow.skip .mr-logo, .mr-prow.skip .mr-rank, .mr-prow.skip .mr-cls { opacity: .5; }
  .mr-prow > .mr-grip { grid-area: g; }
  .mr-prow > .mr-rank { grid-area: r; }
  .mr-prow > .mr-logo { grid-area: l; }
  .mr-prow > .mr-pname { grid-area: n; }
  .mr-prow > .mr-cls { grid-area: c; }
  .mr-prow > .mr-chip { grid-area: s; justify-self: start; }
  .mr-prow > .mr-moves { grid-area: m; }
  .mr-prow > .tog { grid-area: t; }
  .mr-prow.drag {
    z-index: 5; background: var(--card-solid); border-radius: 10px; box-shadow: var(--shadow-lg), 0 0 0 1px var(--line);
    transform-origin: 30% 50%; transition: none;
  }
  .mr-prow.drag .mr-grip, .mr-mrow.drag .mr-grip { cursor: grabbing; }
  .mr-plist.dragging .mr-prow:not(.drag) { transition: transform var(--t-std) var(--ease-std); }
  .mr-cls { display: flex; align-items: center; gap: 8px; min-width: 0; }
  select.sel.mr-sel-sm {
    height: 28px; width: 104px; min-width: 0; flex: none; padding: 0 24px 0 9px; font-size: 12px;
    background-position: calc(100% - 14px) 12px, calc(100% - 9px) 12px !important;
  }
  .mr-res { min-width: 0; font-size: 11.5px; color: var(--dim); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mr-res b { color: var(--muted); font-weight: 500; }
  .mr-res.none { color: var(--warn-ink); }
  .mr-lfoot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; padding: 4px 18px 14px; }
  .mr-lfoot small { color: var(--dim); font-size: 12px; }
  .mr-lempty {
    display: flex; align-items: center; gap: 10px; margin: 4px 18px 6px; padding: 12px 14px; border: 1px dashed var(--line-2);
    border-radius: 10px; color: var(--muted); font-size: 12.5px;
  }
  .mr-lempty .mr-i, .mr-mempty .mr-i { color: var(--dim); }
  .mr-sub {
    display: flex; align-items: center; gap: 8px; padding: 10px 18px 6px; border-top: 1px solid var(--line); font-size: 10.5px;
    font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--dim);
  }
  .mr-sub .r { margin-left: auto; text-transform: none; letter-spacing: 0; font-size: 12px; font-weight: 500; }
  .mr-offlist { list-style: none; margin: 0; padding: 0 0 6px; }
  .mr-offrow { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 10px; align-items: center; padding: 7px 18px 7px 54px; }
  .mr-offrow .mr-logo { opacity: .55; box-shadow: inset 0 0 0 1px var(--line); background: transparent; color: var(--muted); }
  .mr-offrow .mr-pname b { color: var(--muted); font-weight: 500; }
  .mr-offrow:hover .mr-logo { opacity: .8; }
  .mr-offmore .mr-i { width: 13px; height: 13px; transition: transform var(--t-std) var(--ease-std); }
  .mr-offmore.open .mr-i { transform: rotate(90deg); }
  .mr-hint {
    display: flex; gap: 12px; align-items: center; margin: 4px 18px 12px; padding: 11px 14px; border-radius: 10px;
    background: var(--accent-soft); color: var(--accent-2); font-size: 12.5px;
  }
  .mr-hint > span:not(.mr-i) { flex: 1; min-width: 0; color: var(--text); }
  .mr-hint > span b { font-weight: 600; }

  /* Models in each class */
  .mr-cats { list-style: none; margin: 0; padding: 0; }
  .mr-cat + .mr-cat { box-shadow: inset 0 1px 0 var(--line); }
  .mr-cat-h {
    width: 100%; display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; align-items: center; gap: 12px; padding: 12px 18px;
    border: 0; background: none; text-align: left; color: var(--text); transition: background var(--t-instant) var(--ease-std);
  }
  .mr-cat-h:hover { background: var(--ink-03); }
  .mr-cat-h > .mr-i { width: 13px; height: 13px; color: var(--dim); transition: transform var(--t-std) var(--ease-std); }
  .mr-cat.open .mr-cat-h > .mr-i { transform: rotate(90deg); }
  .mr-ct { min-width: 0; }
  .mr-ct b { font-weight: 600; font-size: 13px; }
  .mr-cp { color: var(--dim); font-size: 12px; margin-left: 8px; }
  .mr-sum { display: block; margin-top: 2px; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mr-sum s { text-decoration: none; color: var(--dim); }
  .mr-sum em { font-style: normal; color: var(--dim); padding: 0 4px; }
  .mr-se { color: var(--warn-ink); }
  .mr-cat.open .mr-sum { display: none; }
  .mr-cnow { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); white-space: nowrap; }
  .mr-cnow b { color: var(--text); font-weight: 600; }
  .mr-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 2px var(--ok-soft); flex: none; }
  .mr-dot.cool { background: var(--warn); box-shadow: 0 0 0 2px var(--warn-soft); }
  .mr-dot.off { background: var(--dim); box-shadow: 0 0 0 2px var(--idle-soft); }
  .mr-cat-b { display: grid; grid-template-rows: 0fr; transition: grid-template-rows var(--t-move) var(--ease-std); }
  .mr-cat.open .mr-cat-b { grid-template-rows: 1fr; }
  .mr-cat-b > div { overflow: hidden; min-height: 0; }
  .mr-cat-in { padding: 0 18px 14px 46px; opacity: 0; transition: opacity var(--t-std) var(--ease-std); }
  .mr-cat.open .mr-cat-in { opacity: 1; }
  .mr-ctools { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
  .mr-chelp { color: var(--dim); font-size: 12px; }
  .mr-ctools .mr-link { margin-left: auto; }
  .mr-seg button { transition: background var(--t-fast) var(--ease-std), color var(--t-fast) var(--ease-std); }
  .mr-ctools .mr-seg button { padding: 2px 9px; font-size: 11.5px; }
  .mr-mlist { list-style: none; margin: 0; padding: 0; border: 1px solid var(--line); border-radius: 10px; background: var(--card-solid); position: relative; }
  .mr-mrow {
    display: grid; grid-template-columns: 20px 16px 24px minmax(0, 1fr) auto auto 24px; align-items: center; gap: 9px;
    padding: 6px 8px 6px 6px; position: relative; background: var(--card-solid); border-radius: 10px;
    transition: background var(--t-instant) var(--ease-std);
  }
  .mr-mrow + .mr-mrow { box-shadow: inset 0 1px 0 var(--line); border-radius: 0; }
  .mr-mrow:first-child { border-radius: 10px 10px 0 0; }
  .mr-mrow:last-child { border-radius: 0 0 10px 10px; }
  .mr-mrow:only-child { border-radius: 10px; }
  .mr-mrow:hover { background: color-mix(in srgb, var(--text) 2%, var(--card-solid)); }
  .mr-mrow .mr-logo { width: 24px; height: 24px; border-radius: 7px; font-size: 10.5px; }
  .mr-mrow .mr-rank { font-size: 11px; }
  .mr-mrow.out .mr-mname b { color: var(--muted); font-weight: 500; }
  .mr-mrow.out .mr-logo, .mr-mrow.out .mr-rank { opacity: .5; }
  .mr-mrow.drag { z-index: 5; border-radius: 10px; box-shadow: var(--shadow-lg), 0 0 0 1px var(--line); transform-origin: 30% 50%; transition: none; }
  .mr-mlist.dragging .mr-mrow:not(.drag) { transition: transform var(--t-std) var(--ease-std); }
  .mr-mname { min-width: 0; display: flex; align-items: center; gap: 8px; }
  .mr-mname b { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
  .mr-pb { flex: none; padding: 1px 7px; border-radius: 6px; background: var(--ink-05); color: var(--muted); font-size: 11px; font-weight: 500; white-space: nowrap; }
  .mr-now { flex: none; padding: 1px 7px; border-radius: 6px; background: var(--accent-soft); color: var(--accent-2); font-size: 11px; font-weight: 600; white-space: nowrap; }
  .mr-mempty {
    display: flex; align-items: center; gap: 10px; padding: 12px 14px; border: 1px dashed var(--line-2); border-radius: 10px;
    color: var(--muted); font-size: 12.5px;
  }
  .mr-cfoot { display: flex; align-items: center; gap: 12px; margin-top: 10px; flex-wrap: wrap; }
  .mr-fb { color: var(--dim); font-size: 12px; }

  /* Pickers (Add provider, Add model): menus, so they open instantly */
  .mr-picker {
    position: absolute; z-index: 40; width: 330px; max-width: calc(100vw - 24px); display: flex; flex-direction: column;
    border-radius: 12px; background: var(--card-solid); box-shadow: var(--shadow-lg), 0 0 0 1px var(--line); overflow: hidden; outline: 0;
  }
  .mr-pk-h { padding: 11px 14px 9px; border-bottom: 1px solid var(--line); }
  .mr-pk-h b { display: block; font-weight: 600; }
  .mr-pk-h small { display: block; color: var(--dim); font-size: 11.5px; margin-top: 1px; }
  .mr-pk-b { overflow-y: auto; padding: 4px 0 6px; }
  .mr-pg + .mr-pg { box-shadow: inset 0 1px 0 var(--line); margin-top: 4px; padding-top: 4px; }
  .mr-pgh { display: flex; align-items: center; gap: 8px; padding: 6px 14px 4px; font-size: 12px; }
  .mr-pgh .mr-logo { width: 20px; height: 20px; border-radius: 6px; font-size: 10px; }
  .mr-pgh b { font-weight: 600; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mr-pgh .mr-chip { font-size: 10.5px; padding: 1px 7px 1px 6px; }
  .mr-pi {
    display: flex; width: 100%; align-items: center; gap: 10px; padding: 6px 14px 6px 42px; border: 0; background: none;
    text-align: left; font-size: 12.5px; color: var(--text);
  }
  .mr-pi:hover:not(:disabled), .mr-pi:focus-visible { background: var(--accent-soft); color: var(--accent-2); box-shadow: none; border-radius: 0; }
  .mr-pi span { flex: 1; min-width: 0; }
  .mr-pi code { font: 11px var(--mono); color: var(--dim); }
  .mr-pi:disabled { cursor: default; color: var(--dim); }
  .mr-pi:disabled code { font-family: var(--sans); font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px; }
  .mr-pi:disabled code .mr-i { width: 12px; height: 12px; }
  .mr-pi small { font-size: 11.5px; color: var(--dim); white-space: nowrap; }
  .mr-pk-none { padding: 14px; color: var(--muted); font-size: 12.5px; }

  /* How a request is routed */
  .mr-route { padding: 14px 18px 16px; }
  .mr-rule { color: var(--muted); max-width: 640px; }
  .mr-rule b { color: var(--text); font-weight: 600; }
  .mr-ask { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-top: 14px; }
  .mr-who-line { color: var(--muted); font-size: 12.5px; }
  .mr-who-line b { color: var(--text); font-weight: 600; }
  .mr-path { list-style: none; margin: 14px 0 0; padding: 0; display: flex; flex-direction: column; align-items: flex-start; }
  .mr-step { display: flex; flex-direction: column; align-items: stretch; max-width: 100%; opacity: 0; transform: translateY(6px); animation: mr-in var(--t-move) var(--ease-enter) forwards; }
  .mr-step + .mr-step::before { content: ""; width: 1px; height: 10px; background: var(--line-2); margin: 0 0 0 20px; flex: none; }
  .mr-sbox { display: flex; gap: 9px; align-items: center; padding: 8px 12px 8px 9px; border-radius: 10px; border: 1px solid var(--line); background: var(--card-solid); min-width: 0; }
  .mr-sbox .mr-logo { width: 22px; height: 22px; border-radius: 6px; font-size: 10.5px; }
  .mr-sbox b { display: block; font-weight: 600; font-size: 12.5px; white-space: nowrap; }
  .mr-sbox small { display: block; font-size: 11.5px; color: var(--dim); white-space: nowrap; }
  .mr-ok-i { color: var(--accent-2); }
  .mr-step.pass .mr-sbox { background: transparent; border-style: dashed; }
  .mr-step.pass .mr-sbox b { color: var(--muted); font-weight: 500; text-decoration: line-through; text-decoration-color: var(--line-2); }
  .mr-step.pass.cool small { color: var(--warn-ink); }
  .mr-step.pass.err small { color: var(--bad); }
  .mr-step.use .mr-sbox { border-color: var(--accent-line); box-shadow: 0 0 0 3px var(--accent-soft); }
  .mr-step.use small { color: var(--accent-2); font-family: var(--mono); font-size: 11px; }
  .mr-step.next { opacity: .6; animation-name: mr-in-next; }
  .mr-step.next .mr-sbox { background: transparent; border-style: dashed; }
  .mr-step.empty .mr-sbox { background: var(--paper-2); border-color: transparent; }
  .mr-step.empty .mr-sbox .mr-i { color: var(--muted); }
  .mr-step.wait .mr-sbox { border-color: color-mix(in srgb, var(--warn) 40%, transparent); background: var(--warn-soft); }
  .mr-step.wait small { color: var(--warn-ink); }
  .mr-after { margin-top: 12px; color: var(--dim); font-size: 12px; display: flex; gap: 6px; align-items: flex-start; }
  .mr-after .mr-i { width: 13px; height: 13px; margin-top: 2px; }
  .mr-after > span:not(.mr-i) { flex: 1; min-width: 0; }

  /* Request settings */
  .mr-req > .more { border-top: 0; border-radius: var(--r); }
  .mr-req > .more[aria-expanded="true"] { border-radius: var(--r) var(--r) 0 0; }
  .mr-num { width: 76px; text-align: right; font-variant-numeric: tabular-nums; }

  /* Toast */
  .mr-toast {
    position: fixed; left: 50%; bottom: 22px; z-index: 60; max-width: calc(100vw - 32px); padding: 9px 14px; border-radius: 10px;
    background: var(--card-solid); box-shadow: var(--shadow-lg), 0 0 0 1px var(--line); font-size: 12.5px; color: var(--text);
    opacity: 0; pointer-events: none; transform: translate(-50%, 12px);
    transition: opacity var(--t-fast) var(--ease-exit), transform var(--t-fast) var(--ease-exit);
  }
  .mr-toast.show { opacity: 1; transform: translate(-50%, 0); transition: opacity var(--t-std) var(--ease-enter), transform var(--t-std) var(--ease-enter); }

  /* Narrow: the chip moves under the name, then each row stacks */
  @media (max-width: 1180px) {
    .mr-prow { grid-template-columns: 20px 22px 28px minmax(0, 1fr) 222px auto 34px; grid-template-areas: "g r l n c m t" ". . . s . . ."; row-gap: 4px; }
  }
  @media (max-width: 1000px) {
    .mr-prow { grid-template-columns: 20px 28px minmax(0, 1fr) auto 34px; grid-template-areas: "g l n m t" ". . c c c" ". . s s s"; row-gap: 6px; padding-left: 10px; padding-right: 14px; }
    .mr-prow > .mr-rank { display: none; }
    select.sel.mr-sel-sm { width: 112px; }
  }
  @media (max-width: 720px) {
    .mr-cat-in { padding: 0 12px 14px; }
    .mr-cat-h { padding: 12px 14px; }
    .mr-cp { display: block; margin: 1px 0 0; }
    .mr-cnow { display: none; }
    .mr-mrow { grid-template-columns: 20px 24px minmax(0, 1fr) 24px; grid-template-areas: "g l n x" ". . s m"; row-gap: 4px; padding: 8px 6px; }
    .mr-mrow .mr-rank { display: none; }
    .mr-mrow > .mr-grip { grid-area: g; }
    .mr-mrow > .mr-logo { grid-area: l; }
    .mr-mrow > .mr-mname { grid-area: n; flex-wrap: wrap; row-gap: 3px; }
    .mr-mrow > .mr-rm { grid-area: x; }
    .mr-mrow > .mr-chip { grid-area: s; justify-self: start; }
    .mr-mrow > .mr-moves { grid-area: m; grid-column: 3 / 5; justify-self: end; }
    .mr-ctools .mr-link { margin-left: 0; }
    .mr-lfoot { padding: 4px 14px 14px; }
    .mr-lempty { margin: 4px 14px 6px; }
    .mr-offrow { padding-left: 18px; }
    .mr-sbox b, .mr-sbox small { white-space: normal; }
    .card-h { flex-wrap: wrap; }
    .card-h .r { margin-left: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation-duration: 1ms !important; transition-property: opacity !important; transition-duration: 120ms !important; }
    .mr-step { transform: none !important; }
  }
}

@keyframes mr-in { to { opacity: 1; transform: none; } }
@keyframes mr-in-next { to { opacity: .6; transform: none; } }
</style>
