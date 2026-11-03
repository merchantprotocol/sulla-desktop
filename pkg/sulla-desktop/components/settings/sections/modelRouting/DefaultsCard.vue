<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/**
 * Defaults: who answers a new chat when no agent is picked, and who runs the heartbeat. Each row is
 * Agent (an enabled agent, with its own Model setting) or Model (Sulla on a model choice: Agents list,
 * a class, or a pinned model). The line under each row shows what it resolves to right now, from the
 * same routing state as the rest of the page. Approved mockup: Projects/sulla-desktop/mockups/model-routing.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue';

import RoutingIcon from './RoutingIcon.vue';
import { CLASS_LABELS, defaultResolution, modelName, providerName, providerOrder, type DefaultResolution } from './routingLogic';
import {
  MODEL_DEFAULTS_IPC, sameModelDefaults, type DefaultAgentOption, type ModelDefaultChoice, type ModelDefaultKey, type ModelDefaultsState,
} from '@pkg/agent/languagemodels/modelDefaultsTypes';
import { MODEL_CLASSES, type AgentModelChoice, type ModelClass, type ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

const props = defineProps<{ state: ModelRoutingState; now: number }>();
const emit = defineEmits<{
  (e: 'saved'): void;
  (e: 'error', message: string): void;
  (e: 'toast', message: string): void;
}>();

const ROWS: { key: ModelDefaultKey; title: string; icon: string; help: string; sullaVerb: string }[] = [
  { key: 'chat', title: 'New chats', icon: 'chat', help: 'Who answers a new chat when you don’t pick someone in the chat’s selector.', sullaVerb: 'answers' },
  { key: 'heartbeat', title: 'Heartbeat', icon: 'heart', help: 'Who runs the heartbeat: Sulla’s periodic background check-ins on your goals.', sullaVerb: 'runs it' },
];

const ds = ref<ModelDefaultsState | null>(null);
const root = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const openKey = ref<ModelDefaultKey | null>(null);
let snapshot = '';
let saving = 0;

/** The side that isn't showing keeps its last value, so Agent → Model → Agent loses nothing. Only the active side is saved. */
const remembered = reactive<Record<ModelDefaultKey, { agentId: string; choice: AgentModelChoice }>>({
  chat:      { agentId: 'sulla', choice: { mode: 'list' } },
  heartbeat: { agentId: 'sulla', choice: { mode: 'list' } },
});

const agents = computed<DefaultAgentOption[]>(() => ds.value?.agents ?? []);
const atDefault = computed(() => !!ds.value && sameModelDefaults(ds.value.defaults, ds.value.recommended));
const pinProviders = computed(() => providerOrder(props.state).map(id => props.state.providers.find(p => p.id === id)!).filter(p => p?.connected));

function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)); }
function initials(name: string) { return name.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase(); }
function agentFor(id: string) { return agents.value.find(a => a.slug === id); }
function current(key: ModelDefaultKey): ModelDefaultChoice { return ds.value!.defaults[key]; }
function choiceOf(key: ModelDefaultKey): AgentModelChoice { const d = current(key); return d.kind === 'model' ? d.choice : remembered[key].choice; }
function agentIdOf(key: ModelDefaultKey): string { const d = current(key); return d.kind === 'agent' ? d.agentId : remembered[key].agentId; }
/** A saved agent that is now off or deleted: Sulla stands in (and the row says so). */
function missingAgent(key: ModelDefaultKey): string | null { const d = current(key); return d.kind === 'agent' && !agentFor(d.agentId) ? d.agentId : null; }
function shownAgent(key: ModelDefaultKey): DefaultAgentOption | undefined { return agentFor(agentIdOf(key)) ?? agentFor('sulla'); }

function remember(next: ModelDefaultsState) {
  for (const { key } of ROWS) {
    const d = next.defaults[key];
    if (d.kind === 'agent') remembered[key].agentId = d.agentId;
    else remembered[key].choice = clone(d.choice);
  }
}
function adopt(next: ModelDefaultsState) { ds.value = next; snapshot = JSON.stringify(next); remember(next); }

async function load() {
  try {
    const next: ModelDefaultsState = await ipcRenderer.invoke(MODEL_DEFAULTS_IPC.get);
    for (const { key } of ROWS) { const r = next.recommended[key]; if (r.kind === 'agent') remembered[key].agentId = r.agentId; }
    adopt(next);
  } catch {
    ds.value = null; // An older backend without Defaults: the card stays hidden.
  }
}

/** Changes show at once; the main process validates them, and a rejected save puts the last saved value back. */
async function save(key: ModelDefaultKey, value: ModelDefaultChoice) {
  if (!ds.value) return;
  ds.value.defaults[key] = clone(value);
  if (value.kind === 'agent') remembered[key].agentId = value.agentId; else remembered[key].choice = clone(value.choice);
  const ticket = ++saving;
  try {
    const next: ModelDefaultsState = await ipcRenderer.invoke(MODEL_DEFAULTS_IPC.set, { [key]: clone(value) });
    if (ticket === saving) adopt(next); else snapshot = JSON.stringify(next);
    emit('saved');
  } catch (e) {
    if (ticket === saving) { ds.value = JSON.parse(snapshot); remember(ds.value!); }
    emit('error', e instanceof Error ? e.message : String(e));
  }
}

function setKind(key: ModelDefaultKey, kind: 'agent' | 'model') {
  if (!ds.value || current(key).kind === kind) return;
  closeMenu();
  void save(key, kind === 'agent' ? { kind, agentId: remembered[key].agentId } : { kind, choice: clone(remembered[key].choice) });
}
function onSegKey(e: KeyboardEvent, key: ModelDefaultKey) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
  e.preventDefault();
  const kind = current(key).kind === 'agent' ? 'model' : 'agent';
  setKind(key, kind);
  void nextTick(() => root.value?.querySelector<HTMLElement>(`[data-def="${ key }"] [data-kind="${ kind }"]`)?.focus());
}

function choiceValue(choice: AgentModelChoice) { return choice.mode === 'class' ? `class:${ choice.class }` : choice.mode; }
function setChoice(key: ModelDefaultKey, raw: string) {
  let choice: AgentModelChoice;
  if (raw === 'list') choice = { mode: 'list' };
  else if (raw.startsWith('class:')) choice = { mode: 'class', class: raw.slice(6) as ModelClass };
  else {
    const prev = remembered[key].choice;
    const provider = prev.mode === 'pin' && pinProviders.value.some(p => p.id === prev.provider) ? prev.provider : pinProviders.value[0]?.id;
    if (!provider) return;
    choice = { mode: 'pin', provider, model: prev.mode === 'pin' && prev.provider === provider ? prev.model : firstModel(provider) };
  }
  void save(key, { kind: 'model', choice });
}
function pinModels(provider: string, selected?: string) {
  const list = (props.state.providers.find(p => p.id === provider)?.models ?? []).map(m => ({ id: m.id, label: modelName(props.state, provider, m.id) }));
  if (selected && !list.some(m => m.id === selected)) list.unshift({ id: selected, label: modelName(props.state, provider, selected) });
  return list;
}
function firstModel(provider: string) { return pinModels(provider)[0]?.id ?? ''; }
function setPin(key: ModelDefaultKey, field: 'provider' | 'model', value: string) {
  const choice = choiceOf(key);
  if (choice.mode !== 'pin') return;
  void save(key, { kind: 'model', choice: field === 'provider' ? { mode: 'pin', provider: value, model: firstModel(value) } : { mode: 'pin', provider: choice.provider, model: value } });
}

function resolution(key: ModelDefaultKey): DefaultResolution {
  const d = current(key);
  if (d.kind === 'model') return defaultResolution(props.state, 'Sulla', d.choice, false, props.now);
  const a = shownAgent(key);
  return defaultResolution(props.state, a?.name ?? 'Sulla', a?.modelChoice ?? { mode: 'list' }, true, props.now);
}
function help(row: (typeof ROWS)[number]) {
  return `${ row.help } ${ current(row.key).kind === 'model' ? `Sulla ${ row.sullaVerb } on the model you choose.` : 'That agent’s own Model setting applies.' }`;
}

async function reset() {
  if (!ds.value) return;
  closeMenu();
  try {
    const next: ModelDefaultsState = await ipcRenderer.invoke(MODEL_DEFAULTS_IPC.reset);
    saving++;
    for (const { key } of ROWS) remembered[key].choice = { mode: 'list' };
    adopt(next);
    emit('saved');
    const hb = next.defaults.heartbeat;
    const runner = hb.kind === 'agent' && hb.agentId === 'heartbeat' ? 'the Heartbeat agent runs the heartbeat' : 'Sulla runs the heartbeat';
    emit('toast', `Defaults are back: Sulla answers new chats and ${ runner }, on the Agents list.`);
  } catch (e) {
    emit('error', e instanceof Error ? e.message : String(e));
  }
}

// ── Agent dropdown: a listbox, so each agent can show its one-line "when to call" ──
const menuAgents = computed(() => ({ first: agents.value.filter(a => a.slug === 'sulla'), rest: agents.value.filter(a => a.slug !== 'sulla') }));
function trigger(key: ModelDefaultKey) { return root.value?.querySelector<HTMLElement>(`.mr-dd[data-def="${ key }"]`) ?? null; }
function place() {
  const key = openKey.value; const btn = key ? trigger(key) : null;
  if (!pop.value || !btn || !root.value) return;
  const r = btn.getBoundingClientRect(); const rr = root.value.getBoundingClientRect(); const w = pop.value.offsetWidth;
  const below = window.innerHeight - r.bottom - 16; const above = r.top - 16; const up = below < 280 && above > below;
  pop.value.style.maxHeight = `${ Math.max(160, Math.min(420, up ? above : below)) }px`;
  pop.value.style.left = `${ Math.max(12, Math.min(r.right - w, window.innerWidth - w - 12)) - rr.left }px`;
  pop.value.style.top = `${ up ? r.top - rr.top - 6 - pop.value.offsetHeight : r.bottom - rr.top + 6 }px`;
}
function onOutside(e: PointerEvent) {
  const t = e.target as Node;
  if (!pop.value?.contains(t) && !(openKey.value && trigger(openKey.value)?.contains(t))) closeMenu();
}
async function openMenu(key: ModelDefaultKey) {
  if (openKey.value === key) return closeMenu(true);
  closeMenu();
  openKey.value = key;
  await nextTick();
  place();
  (pop.value?.querySelector<HTMLElement>('[aria-selected="true"]') ?? pop.value?.querySelector<HTMLElement>('.mr-ddi'))?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  window.addEventListener('resize', place);
  window.addEventListener('scroll', place, true);
}
function closeMenu(refocus = false) {
  const key = openKey.value;
  if (!key) return;
  openKey.value = null;
  document.removeEventListener('pointerdown', onOutside, true);
  window.removeEventListener('resize', place);
  window.removeEventListener('scroll', place, true);
  if (refocus) trigger(key)?.focus({ preventScroll: true });
}
function pick(slug: string) {
  const key = openKey.value; if (!key) return;
  closeMenu(true);
  if (current(key).kind !== 'agent' || agentIdOf(key) !== slug || missingAgent(key)) void save(key, { kind: 'agent', agentId: slug });
}
function onMenuKey(e: KeyboardEvent) {
  const items = [...(pop.value?.querySelectorAll<HTMLElement>('.mr-ddi') ?? [])]; const i = items.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); }
  else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); items[e.key === 'Home' ? 0 : items.length - 1]?.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
  else if (e.key === 'Tab') closeMenu();
}

onMounted(() => { void load(); });
onBeforeUnmount(() => closeMenu());
</script>

<template>
  <section
    v-if="ds"
    ref="root"
    class="card mr-card mr-def"
    :class="{ picking: !!openKey }"
    aria-labelledby="mr-def-h"
  >
    <div class="card-h">
      <div>
        <h2 id="mr-def-h">
          Defaults
        </h2>
        <p>Who answers when you don’t choose. Pick an agent, or have Sulla answer on a model you choose.</p>
      </div>
      <div class="r">
        <button
          type="button"
          class="link mr-link"
          :disabled="atDefault"
          :title="atDefault ? 'Already the default' : undefined"
          @click="reset"
        >
          Reset to default
        </button>
      </div>
    </div>

    <div
      v-for="row in ROWS"
      :key="row.key"
      class="set mr-def-set"
      :data-def="row.key"
    >
      <div class="l">
        <b><RoutingIcon :name="row.icon" />{{ row.title }}</b>
        <small>{{ help(row) }}</small>
        <div
          class="mr-resolve"
          aria-live="polite"
        >
          <template v-if="missingAgent(row.key)">
            <span class="mr-wt">{{ missingAgent(row.key) }} is off or deleted, so Sulla stands in.</span>
          </template>
          → <b>{{ resolution(row.key).agent }}</b> · uses {{ resolution(row.key).uses }} →
          <template v-if="resolution(row.key).model">
            <b>{{ resolution(row.key).model }}</b>
          </template>
          <span :class="{ 'mr-wt': resolution(row.key).warn }">{{ resolution(row.key).text }}</span>
        </div>
      </div>
      <div class="c">
        <div class="mr-defctl">
          <div
            class="seg mr-seg"
            role="radiogroup"
            :aria-label="`${ row.title }: answer with`"
          >
            <button
              v-for="k in (['agent', 'model'] as const)"
              :key="k"
              type="button"
              role="radio"
              :data-kind="k"
              :aria-checked="current(row.key).kind === k"
              :tabindex="current(row.key).kind === k ? 0 : -1"
              :class="{ on: current(row.key).kind === k }"
              @click="setKind(row.key, k)"
              @keydown="onSegKey($event, row.key)"
            >
              {{ k === 'agent' ? 'Agent' : 'Model' }}
            </button>
          </div>
          <button
            v-if="current(row.key).kind === 'agent'"
            type="button"
            class="mr-dd"
            :data-def="row.key"
            aria-haspopup="listbox"
            :aria-expanded="openKey === row.key"
            :aria-label="`${ row.title }: agent, ${ shownAgent(row.key)?.name ?? 'Sulla' }`"
            @click="openMenu(row.key)"
            @keydown.down.prevent="openMenu(row.key)"
            @keydown.up.prevent="openMenu(row.key)"
          >
            <span
              class="mr-av"
              :class="{ me: shownAgent(row.key)?.slug === 'sulla' }"
              aria-hidden="true"
            >{{ initials(shownAgent(row.key)?.name ?? 'Sulla') }}</span>
            <span class="mr-dd-name">{{ shownAgent(row.key)?.name ?? 'Sulla' }}</span>
            <RoutingIcon name="chev" />
          </button>
          <select
            v-else
            class="sel"
            :aria-label="`${ row.title } model`"
            :value="choiceValue(choiceOf(row.key))"
            @change="setChoice(row.key, ($event.target as HTMLSelectElement).value)"
          >
            <option value="list">
              Agents list (default)
            </option>
            <option
              v-for="c in MODEL_CLASSES"
              :key="c"
              :value="`class:${ c }`"
            >
              Class: {{ CLASS_LABELS[c] }}
            </option>
            <option
              value="pin"
              :disabled="!pinProviders.length"
            >
              Pin a specific model{{ pinProviders.length ? '' : ' (connect a provider first)' }}
            </option>
          </select>
        </div>
        <div
          v-if="current(row.key).kind === 'model' && choiceOf(row.key).mode === 'pin'"
          class="mr-defctl"
        >
          <select
            class="sel"
            aria-label="Pinned provider"
            :value="(choiceOf(row.key) as { provider: string }).provider"
            @change="setPin(row.key, 'provider', ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-if="!pinProviders.some(p => p.id === (choiceOf(row.key) as { provider: string }).provider)"
              :value="(choiceOf(row.key) as { provider: string }).provider"
            >
              {{ providerName(state, (choiceOf(row.key) as { provider: string }).provider) }} (not connected)
            </option>
            <option
              v-for="p in pinProviders"
              :key="p.id"
              :value="p.id"
            >
              {{ providerName(state, p.id) }}
            </option>
          </select>
          <select
            class="sel"
            aria-label="Pinned model"
            :value="(choiceOf(row.key) as { model: string }).model"
            @change="setPin(row.key, 'model', ($event.target as HTMLSelectElement).value)"
          >
            <option
              v-for="m in pinModels((choiceOf(row.key) as { provider: string }).provider, (choiceOf(row.key) as { model: string }).model)"
              :key="m.id"
              :value="m.id"
            >
              {{ m.label }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <div
      v-if="openKey"
      ref="pop"
      class="mr-ddp"
      role="listbox"
      :aria-label="`${ ROWS.find(r => r.key === openKey)?.title }: choose an agent`"
      @keydown="onMenuKey"
    >
      <template
        v-for="(group, gi) in [menuAgents.first, menuAgents.rest]"
        :key="gi"
      >
        <template v-if="gi === 1 && group.length">
          <div
            class="mr-ddsep"
            role="presentation"
          />
          <div
            class="mr-ddh"
            role="presentation"
          >
            Agent Directory
          </div>
        </template>
        <button
          v-for="a in group"
          :key="a.slug"
          type="button"
          class="mr-ddi"
          role="option"
          :aria-selected="current(openKey).kind === 'agent' && agentIdOf(openKey) === a.slug"
          :title="a.whenToCall"
          @click="pick(a.slug)"
        >
          <span
            class="mr-av"
            :class="{ me: a.slug === 'sulla' }"
            aria-hidden="true"
          >{{ initials(a.name) }}</span>
          <span><b>{{ a.name }}</b><small>{{ a.whenToCall }}</small></span>
          <RoutingIcon name="check" />
        </button>
      </template>
    </div>
  </section>
</template>
