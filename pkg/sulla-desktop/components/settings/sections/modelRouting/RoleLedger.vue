<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/**
 * Models for each role, as a ledger: one line per connected provider under each role, with the model
 * and effort editable on the line. Rules, order, removal and never-use pairs open on demand.
 * Edits stay a draft until Save; Discard drops them. Approved mockup: mockups/roles-option-3.html.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';

import {
  addableProviders, chipChanged, chipHealth, defaultEffort, effortLabel, effortLevels, effortUnsupported, firstUsableModel,
  isLevelBlocked, isNewModel, laneChanged, provenanceText, upgradeFor, usedBy, visibleRoles,
} from './laneLogic';
import { clearDraft, keepDraft, takeDraft } from './ledgerDraft';
import { CLASS_LABELS, modelName, orderedClassModels, providerName } from './routingLogic';

import { effectiveEffort, isAutoEntry, isBlocked, resolveRule } from '@pkg/agent/languagemodels/modelCatalogRules';
import { MODEL_CLASSES, type ClassModel, type ModelClass, type ModelRoutingState, type ModelRule, type NeverUsePair } from '@pkg/agent/languagemodels/modelRoutingTypes';
const kept: { base: string; lanes: unknown; never: unknown } = { base: '', lanes: null, never: null };

type Patch = Pick<ModelRoutingState, 'classes' | 'followProviderOrder' | 'neverUse'>;
const props = defineProps<{ state: ModelRoutingState; now: number; refreshing: boolean }>();
const emit = defineEmits<{ (e: 'save', patch: Patch): void; (e: 'refresh'): void }>();

type Lanes = Record<ModelClass, ClassModel[]>;
function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) }
function savedLanes(): Lanes { return Object.fromEntries(MODEL_CLASSES.map(c => [c, orderedClassModels(props.state, c)])) as Lanes }

const baseKey = () => JSON.stringify({ c: props.state.classes, n: props.state.neverUse ?? [], f: props.state.followProviderOrder });
const restored = takeDraft<Lanes, NeverUsePair[]>(baseKey());
const draft = ref<Lanes>(restored ? restored.lanes : savedLanes());
const never = ref<NeverUsePair[]>(restored ? restored.never : clone(props.state.neverUse ?? []));
const saved = computed(savedLanes);
const view = computed<ModelRoutingState>(() => ({ ...props.state, neverUse: never.value }));
const roles = computed(() => visibleRoles(props.state));
const changedRoles = computed(() => MODEL_CLASSES.filter(c => laneChanged(saved.value[c], draft.value[c])));
const neverChanged = computed(() => JSON.stringify(never.value) !== JSON.stringify(props.state.neverUse ?? []));
const dirty = computed(() => changedRoles.value.length > 0 || neverChanged.value);

watch(() => props.state, () => {
  if (dirty.value) return;
  draft.value = savedLanes();
  never.value = clone(props.state.neverUse ?? []);
});

// ── Lookups ────────────────────────────────────────────────────────────────
const connected = (p: string) => !!props.state.providers.find(x => x.id === p)?.connected;
const modelsOf = (p: string) => props.state.providers.find(x => x.id === p)?.models ?? [];
const label = (p: string, model: string) => model ? modelName(props.state, p, model) : 'No model chosen';
const canCheck = (p: string) => modelsOf(p).some(m => !m.unverified && !isAutoEntry(p, m.id));
/** Lines shown under a role: its connected providers, at their real positions. */
const lines = (c: ModelClass) => draft.value[c].map((m, i) => ({ m, i })).filter(x => connected(x.m.provider));
const hiddenProviders = (c: ModelClass) => draft.value[c].filter(m => !connected(m.provider)).map(m => providerName(props.state, m.provider));
const addable = (c: ModelClass) => addableProviders(props.state, c, draft.value[c]);
const notConnected = computed(() => props.state.providers.filter(p => !p.connected).map(p => p.name ? providerName(props.state, p.id) : p.id));

function edited(c: ModelClass, i: number, field: 'model' | 'effort'): boolean {
  const a = saved.value[c][i]; const b = draft.value[c][i];
  if (a?.provider !== b?.provider) return true;
  return field === 'model' ? a.model !== b.model || JSON.stringify(a.rule ?? null) !== JSON.stringify(b.rule ?? null) : (a.effort ?? '') !== (b.effort ?? '');
}

interface Problem { text: string; fixes: { label: string; run: () => void }[] }
function problems(c: ModelClass, i: number): Problem[] {
  const m = draft.value[c][i]; const p = providerName(props.state, m.provider); const out: Problem[] = [];
  const health = chipHealth(view.value, m);
  if (health === 'unlisted') {
    const next = upgradeFor(view.value, m);
    // With no successor named by the provider, offer what it does list (up to three), so there is always a one-click way out.
    const offered = next ? [next] : modelsOf(m.provider).filter(x => !isAutoEntry(m.provider, x.id) && !isBlocked(never.value, m.provider, x.id)).slice(0, 3).map(x => x.id);
    out.push({
      text:  `${ m.model } is Sulla's built-in choice, but ${ p } doesn't offer it to your account.${ next ? ` ${ p } suggests ${ label(m.provider, next) }.` : '' }`,
      fixes: offered.map(id => ({ label: `Use ${ label(m.provider, id) }`, run: () => pick(c, i, id) })),
    });
  }
  if (health === 'blocked') {
    const eff = effectiveEffort(m, modelsOf(m.provider));
    const pair = never.value.find(b => b.provider === m.provider && b.model === m.model && (b.effort === 'any' || b.effort === eff));
    out.push({ text: `${ label(m.provider, m.model) }${ pair && pair.effort !== 'any' ? ` at ${ effortLabel(pair.effort) }` : '' } is on your never-use list, so Sulla skips it here.`, fixes: pair ? [{ label: 'Allow it again', run: () => removePair(pair) }] : [] });
  }
  if (effortUnsupported(view.value, m)) {
    const ok = effortLevels(props.state, m).filter(l => !isLevelBlocked(view.value, m.provider, m.model, l.id));
    const top = ok[ok.length - 1]?.id;
    out.push({ text: `${ label(m.provider, m.model) } doesn't support ${ effortLabel(m.effort!) } effort.`, fixes: [{ label: top ? `Use ${ effortLabel(top) }` : 'Use the default', run: () => setEffort(c, i, top) }] });
  }
  return out;
}
const problemCount = computed(() => roles.value.reduce((n, c) => n + lines(c).reduce((k, x) => k + problems(c, x.i).length, 0), 0));

// ── Edits ──────────────────────────────────────────────────────────────────
function replace(c: ModelClass, i: number, next: ClassModel) {
  if (next.effort && !effortLevels(props.state, next).some(l => l.id === next.effort)) delete next.effort;
  draft.value[c].splice(i, 1, next);
}
function pick(c: ModelClass, i: number, model: string) {
  const cur = draft.value[c][i];
  const next: ClassModel = { provider: cur.provider, model, chosen: true, ...(cur.effort ? { effort: cur.effort } : {}) };
  replace(c, i, next);
}
function useRule(c: ModelClass, i: number, rule: ModelRule) {
  const cur = draft.value[c][i];
  const model = resolveRule(rule, cur.provider, modelsOf(cur.provider), never.value);
  if (model) replace(c, i, { provider: cur.provider, model, rule, chosen: true, ...(cur.effort ? { effort: cur.effort } : {}) });
}
function rulePreview(c: ModelClass, i: number, rule: ModelRule): string {
  const cur = draft.value[c][i];
  const id = resolveRule(rule, cur.provider, modelsOf(cur.provider), never.value);
  return id ? `picks ${ label(cur.provider, id) } today` : 'matches nothing today';
}
function setEffort(c: ModelClass, i: number, effort: string | undefined) {
  const next = { ...draft.value[c][i], chosen: true };
  if (effort) next.effort = effort; else delete next.effort;
  draft.value[c].splice(i, 1, next);
}
function move(c: ModelClass, i: number, delta: number) {
  const lane = draft.value[c];
  // Move past providers that aren't connected, so the visible order changes with one click.
  let j = i + delta;
  while (j >= 0 && j < lane.length && !connected(lane[j].provider)) j += delta;
  if (j < 0 || j >= lane.length) return;
  const [item] = lane.splice(i, 1); lane.splice(j, 0, item);
}
function remove(c: ModelClass, i: number) { draft.value[c].splice(i, 1); open.value = '' }
function add(c: ModelClass, p: string) { draft.value[c].push({ provider: p, model: firstUsableModel(view.value, p), chosen: true }) }
function addPair(pair: NeverUsePair) {
  if (!never.value.some(b => b.provider === pair.provider && b.model === pair.model && b.effort === pair.effort)) never.value = [...never.value, pair];
}
function removePair(pair: NeverUsePair) { never.value = never.value.filter(b => !(b.provider === pair.provider && b.model === pair.model && b.effort === pair.effort)) }
function discard() { draft.value = savedLanes(); never.value = clone(props.state.neverUse ?? []); open.value = ''; closePop() }
function save() {
  if (!dirty.value) return;
  const follow = { ...props.state.followProviderOrder };
  // A role you edited keeps the order you set rather than re-sorting by the provider list.
  for (const c of changedRoles.value) follow[c] = false;
  emit('save', { classes: clone(draft.value), followProviderOrder: follow, neverUse: clone(never.value) });
  clearDraft();
  open.value = '';
}

// ── Disclosure and the model menu ───────────────────────────────────────────
const open = ref('');
const toggle = (key: string) => { open.value = open.value === key ? '' : key };
const ruleText = ref<Record<string, string>>({});
const menu = ref<{ c: ModelClass; i: number; q: string } | null>(null);
const MENU_CAP = 60;
function openMenu(c: ModelClass, i: number) {
  menu.value = menu.value?.c === c && menu.value.i === i ? null : { c, i, q: '' };
  nextTick(() => document.querySelector<HTMLInputElement>('.ld-menu input')?.focus()).catch(() => undefined);
}
function closePop() { menu.value = null }
const menuModels = computed(() => {
  if (!menu.value) return [];
  const m = draft.value[menu.value.c][menu.value.i]; const q = menu.value.q.trim().toLowerCase();
  return modelsOf(m.provider).filter(x => !q || x.id.toLowerCase().includes(q) || x.label.toLowerCase().includes(q));
});
function onDocClick(e: MouseEvent) {
  if (menu.value && !(e.target as HTMLElement).closest('.ld-menu, .ld-model')) closePop();
}
function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && menu.value) closePop(); }
onMounted(() => { document.addEventListener('click', onDocClick); document.addEventListener('keydown', onKey) });
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocClick); document.removeEventListener('keydown', onKey);
  if (dirty.value) keepDraft({ base: baseKey(), lanes: clone(draft.value), never: clone(never.value) });
});

// ── Never-use pair builder ─────────────────────────────────────────────────
const pairProvider = ref('');
const pairModel = ref('');
const pairEffort = ref('any');
const pairProviders = computed(() => props.state.providers.filter(p => p.connected && p.models.length));
const pairModels = computed(() => modelsOf(pairProvider.value).filter(m => !isAutoEntry(pairProvider.value, m.id)));
const pairLevels = computed(() => modelsOf(pairProvider.value).find(m => m.id === pairModel.value)?.efforts ?? []);
watch(pairProviders, list => { if (!pairProvider.value && list[0]) pairProvider.value = list[0].id; }, { immediate: true });
watch(pairProvider, () => { pairModel.value = pairModels.value[0]?.id ?? ''; pairEffort.value = 'any' });
function addBuiltPair() { if (pairProvider.value && pairModel.value) addPair({ provider: pairProvider.value, model: pairModel.value, effort: pairEffort.value }); }
const pairText = (b: NeverUsePair) => `${ label(b.provider, b.model) } at ${ b.effort === 'any' ? 'any effort' : effortLabel(b.effort) }`;

// ── Pending summary and header ─────────────────────────────────────────────
const pending = computed(() => {
  const out: string[] = [];
  for (const c of changedRoles.value) {
    const a = saved.value[c]; const b = draft.value[c]; const name = CLASS_LABELS[c];
    for (const m of b) if (!a.some(x => x.provider === m.provider)) out.push(`${ name }: added ${ providerName(props.state, m.provider) }`);
    for (const m of a) if (!b.some(x => x.provider === m.provider)) out.push(`${ name }: removed ${ providerName(props.state, m.provider) }`);
    const keptA = a.filter(m => b.some(x => x.provider === m.provider)).map(m => m.provider).join();
    const keptB = b.filter(m => a.some(x => x.provider === m.provider)).map(m => m.provider).join();
    if (keptA !== keptB) out.push(`${ name }: new order ${ b.filter(m => connected(m.provider)).map(m => providerName(props.state, m.provider)).join(', then ') }`);
    for (const m of b) {
      const old = a.find(x => x.provider === m.provider);
      if (!old) continue;
      const p = providerName(props.state, m.provider);
      if (old.model !== m.model || JSON.stringify(old.rule ?? null) !== JSON.stringify(m.rule ?? null)) out.push(`${ name }, ${ p }: ${ label(m.provider, old.model) } to ${ label(m.provider, m.model) }`);
      if ((old.effort ?? '') !== (m.effort ?? '')) out.push(`${ name }, ${ p }: effort ${ old.effort ? effortLabel(old.effort) : 'default' } to ${ m.effort ? effortLabel(m.effort) : 'default' }`);
    }
  }
  const before = props.state.neverUse ?? [];
  for (const b of never.value) if (!before.some(x => x.provider === b.provider && x.model === b.model && x.effort === b.effort)) out.push(`Never use ${ pairText(b) }`);
  for (const b of before) if (!never.value.some(x => x.provider === b.provider && x.model === b.model && x.effort === b.effort)) out.push(`Allowed again: ${ pairText(b) }`);
  return out;
});
function ago(iso: string | null | undefined): string {
  if (!iso) return 'not yet';
  const min = Math.round((props.now - Date.parse(iso)) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${ min } min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${ h } h ago` : new Date(iso).toLocaleDateString();
}
const SHORT: Record<string, string> = { low: 'Low', medium: 'Med', high: 'High', xhigh: 'XHigh', max: 'Max', ultra: 'Ultra' };
const effortShort = (id: string) => SHORT[id] ?? effortLabel(id);
function sourceText(c: ModelClass, i: number): string {
  return chipChanged(saved.value[c], draft.value[c], i) ? 'Unsaved' : provenanceText(props.state, c, draft.value[c][i]);
}
</script>

<template>
  <section
    class="card ld"
    :class="{ pend: dirty }"
    aria-label="Models for each role"
  >
    <header class="ld-head">
      <div>
        <h2>Models for each role</h2>
        <p>Agents ask for a role. Sulla tries that role's providers in order and moves on when one is unavailable or out of usage.</p>
      </div>
      <div class="ld-head-r">
        <span
          v-if="problemCount"
          class="ld-count"
        >{{ problemCount }} to fix</span>
        <span
          class="ld-dim"
          aria-live="polite"
        >{{ refreshing ? 'Checking lists…' : `Lists checked ${ago(state.catalog?.checkedAt)}` }}</span>
        <button
          type="button"
          class="btn sm"
          :disabled="refreshing"
          @click="emit('refresh')"
        >
          Refresh models
        </button>
      </div>
    </header>

    <div
      class="ld-grid ld-colhead"
      aria-hidden="true"
    >
      <span>Try</span><span>Provider</span><span>Model</span><span>Effort</span><span />
    </div>

    <template
      v-for="c in roles"
      :key="c"
    >
      <div class="ld-role">
        <b>{{ CLASS_LABELS[c] }}</b>
        <span
          class="ld-users"
          :title="usedBy(state, c).join(', ')"
        >{{ usedBy(state, c).length ? `Used by ${usedBy(state, c).join(', ')}` : 'Used by agents that ask for this role' }}</span>
        <button
          type="button"
          class="ld-ghost"
          :aria-expanded="open === `add:${c}`"
          @click="toggle(`add:${c}`)"
        >
          {{ open === `add:${c}` ? 'Hide' : 'Add provider' }}
        </button>
      </div>

      <div
        v-if="open === `add:${c}`"
        class="ld-sub"
      >
        <div
          v-if="addable(c).length"
          class="ld-row-wrap"
        >
          <span class="ld-dim">Connected, not in this role:</span>
          <button
            v-for="p in addable(c)"
            :key="p"
            type="button"
            class="btn sm"
            @click="add(c, p)"
          >
            Add {{ providerName(state, p) }}
          </button>
        </div>
        <p class="ld-dim">
          <template v-if="hiddenProviders(c).length">
            Also in this role but not connected, so skipped: {{ hiddenProviders(c).join(', ') }}.
          </template>
          <template v-else-if="notConnected.length">
            Not connected: {{ notConnected.join(', ') }}. Connect them in Integrations.
          </template>
        </p>
      </div>

      <p
        v-if="!lines(c).length"
        class="ld-grid ld-line ld-empty"
      >
        <span /><span class="ld-empty-t">No connected provider in {{ CLASS_LABELS[c] }}. Agents that ask for it fall back to another role.</span>
      </p>

      <template
        v-for="({ m, i }, k) in lines(c)"
        :key="`${c}-${m.provider}`"
      >
        <div
          class="ld-grid ld-line"
          :class="{ bad: problems(c, i).length, open: open === `line:${c}:${i}` }"
        >
          <span class="ld-ord">{{ k + 1 }}</span>
          <span class="ld-prov">
            <b>{{ providerName(state, m.provider) }}</b>
            <small :class="{ ac: sourceText(c, i) === 'Unsaved' }">{{ sourceText(c, i) }}<template v-if="!canCheck(m.provider)"> · can't be checked</template></small>
          </span>
          <span class="ld-model-wrap">
            <button
              type="button"
              class="ld-model"
              :class="{ bad: chipHealth(view, m) === 'unlisted' || chipHealth(view, m) === 'blocked', ed: edited(c, i, 'model') }"
              aria-haspopup="listbox"
              :aria-expanded="menu?.c === c && menu.i === i"
              :aria-label="`${providerName(state, m.provider)} model for ${CLASS_LABELS[c]}: ${label(m.provider, m.model)}`"
              @click="openMenu(c, i)"
            >
              <span class="ld-lbl">{{ label(m.provider, m.model) }}</span>
              <svg
                class="ld-i"
                viewBox="0 0 16 16"
                aria-hidden="true"
              ><path d="M4 6l4 4 4-4" /></svg>
            </button>
            <div
              v-if="menu?.c === c && menu.i === i"
              class="ld-menu"
              role="dialog"
              :aria-label="`Choose the ${providerName(state, m.provider)} model`"
            >
              <div class="ld-menu-q">
                <input
                  v-model="menu.q"
                  type="search"
                  class="inp sm"
                  :placeholder="`Search ${modelsOf(m.provider).length} ${providerName(state, m.provider)} models`"
                  aria-label="Search models"
                >
              </div>
              <div
                class="ld-menu-list"
                role="listbox"
              >
                <div
                  v-if="chipHealth(view, m) === 'unlisted' && !menu.q"
                  class="ld-opt gone"
                >
                  <s>{{ m.model }}</s><span class="ld-tag warn">No longer listed</span>
                </div>
                <button
                  v-for="x in menuModels.slice(0, MENU_CAP)"
                  :key="x.id"
                  type="button"
                  role="option"
                  class="ld-opt"
                  :class="{ cur: !m.rule && m.model === x.id }"
                  :aria-selected="!m.rule && m.model === x.id"
                  :disabled="isBlocked(never, m.provider, x.id)"
                  @click="pick(c, i, x.id); closePop()"
                >
                  <span class="ld-opt-n">{{ x.label || x.id }}</span>
                  <span
                    v-if="isAutoEntry(m.provider, x.id)"
                    class="ld-tag"
                  >The provider chooses</span>
                  <span
                    v-if="isNewModel(state, m.provider, x.id)"
                    class="ld-tag new"
                  >New</span>
                  <span
                    v-if="upgradeFor(view, m) === x.id && chipHealth(view, m) === 'unlisted'"
                    class="ld-tag warn"
                  >Suggested</span>
                  <span
                    v-if="isBlocked(never, m.provider, x.id)"
                    class="ld-tag"
                  >Never use</span>
                </button>
                <p
                  v-if="menuModels.length > MENU_CAP"
                  class="ld-menu-note"
                >
                  Showing {{ MENU_CAP }} of {{ menuModels.length }}. Type to narrow.
                </p>
                <p
                  v-if="!menuModels.length"
                  class="ld-menu-note"
                >
                  No model matches.
                </p>
              </div>
              <p class="ld-menu-foot">
                {{ canCheck(m.provider) ? `Live list from ${providerName(state, m.provider)}, in its own order.` : `${providerName(state, m.provider)} publishes no model list for your sign-in, so this is Sulla's built-in list.` }}
              </p>
            </div>
          </span>
          <span
            class="ld-seg"
            :class="{ ed: edited(c, i, 'effort') }"
            role="radiogroup"
            :aria-label="`${providerName(state, m.provider)} effort for ${CLASS_LABELS[c]}`"
          >
            <template v-if="effortLevels(state, m).length">
              <button
                type="button"
                role="radio"
                :aria-checked="!m.effort"
                :title="defaultEffort(state, m) ? `${providerName(state, m.provider)} reports ${effortLabel(defaultEffort(state, m)!)} as the default` : `${providerName(state, m.provider)} reports no default`"
                @click="setEffort(c, i, undefined)"
              >Default<span
                v-if="defaultEffort(state, m)"
                class="ld-dft ld-full"
              > ({{ effortLabel(defaultEffort(state, m)!) }})</span></button>
              <button
                v-for="l in effortLevels(state, m)"
                :key="l.id"
                type="button"
                role="radio"
                :aria-checked="m.effort === l.id"
                :disabled="isLevelBlocked(view, m.provider, m.model, l.id) && m.effort !== l.id"
                :class="{ badsel: m.effort === l.id && isLevelBlocked(view, m.provider, m.model, l.id) }"
                :title="isLevelBlocked(view, m.provider, m.model, l.id) ? 'On your never-use list for this model' : l.description"
                @click="setEffort(c, i, l.id)"
              ><span class="ld-full">{{ effortLabel(l.id) }}</span><span class="ld-short">{{ effortShort(l.id) }}</span></button>
            </template>
            <span
              v-else
              class="ld-dim"
            >No effort setting</span>
          </span>
          <button
            type="button"
            class="ld-ghost ld-more"
            :aria-expanded="open === `line:${c}:${i}`"
            :aria-label="`Rule, order and never-use for ${providerName(state, m.provider)} in ${CLASS_LABELS[c]}`"
            @click="toggle(`line:${c}:${i}`)"
          >
            {{ open === `line:${c}:${i}` ? 'Close' : 'More' }}
          </button>
        </div>

        <div
          v-if="problems(c, i).length"
          class="ld-prob"
        >
          <div
            v-for="(p, pi) in problems(c, i)"
            :key="pi"
            class="ld-prob-row"
            role="alert"
          >
            <svg
              class="ld-i"
              viewBox="0 0 16 16"
              aria-hidden="true"
            ><path d="M8 2.2 14.3 13H1.7L8 2.2Z" /><path d="M8 6.5v3" /><path d="M8 11.3v.2" /></svg>
            <span>{{ p.text }}</span>
            <button
              v-for="f in p.fixes"
              :key="f.label"
              type="button"
              class="ld-fix"
              @click="f.run()"
            >
              {{ f.label }}
            </button>
          </div>
        </div>

        <div
          v-if="open === `line:${c}:${i}`"
          class="ld-det"
        >
          <div>
            <h4>How the model is chosen</h4>
            <div
              class="ld-rules"
              role="radiogroup"
            >
              <label><input
                type="radio"
                :name="`rule-${c}-${i}`"
                :checked="!m.rule"
                @change="pick(c, i, m.model)"
              > The model I pick <span class="ld-dim">{{ label(m.provider, m.model) }}</span></label>
              <label v-if="modelsOf(m.provider).length"><input
                type="radio"
                :name="`rule-${c}-${i}`"
                :checked="m.rule?.kind === 'first'"
                @change="useRule(c, i, { kind: 'first' })"
              > First model in the provider's list <span class="ld-dim">{{ rulePreview(c, i, { kind: 'first' }) }}</span></label>
              <label v-if="modelsOf(m.provider).length"><input
                                                          type="radio"
                                                          :name="`rule-${c}-${i}`"
                                                          :checked="m.rule?.kind === 'contains'"
                                                          @change="(ruleText[`${c}:${i}`] ?? '').trim() && useRule(c, i, { kind: 'contains', text: ruleText[`${c}:${i}`].trim() })"
                                                        > Name contains
                <input
                  class="inp sm ld-rule-in"
                  maxlength="60"
                  placeholder="text"
                  aria-label="Text the model name must contain"
                  :value="ruleText[`${c}:${i}`] ?? (m.rule?.kind === 'contains' ? m.rule.text : '')"
                  @input="ruleText[`${c}:${i}`] = ($event.target as HTMLInputElement).value; ($event.target as HTMLInputElement).value.trim() && useRule(c, i, { kind: 'contains', text: ($event.target as HTMLInputElement).value.trim() })"
                >
                <span class="ld-dim">{{ (ruleText[`${c}:${i}`] ?? '').trim() ? rulePreview(c, i, { kind: 'contains', text: ruleText[`${c}:${i}`].trim() }) : '' }}</span>
              </label>
            </div>
          </div>
          <div class="ld-acts">
            <button
              type="button"
              class="btn sm"
              :disabled="k === 0"
              @click="move(c, i, -1)"
            >
              Try earlier
            </button>
            <button
              type="button"
              class="btn sm"
              :disabled="k === lines(c).length - 1"
              @click="move(c, i, 1)"
            >
              Try later
            </button>
            <button
              type="button"
              class="btn sm"
              @click="addPair({ provider: m.provider, model: m.model, effort: m.effort || 'any' })"
            >
              Never use {{ label(m.provider, m.model) }} at {{ m.effort ? effortLabel(m.effort) : 'any effort' }}
            </button>
            <button
              type="button"
              class="ld-ghost ld-rm"
              @click="remove(c, i)"
            >
              Remove from {{ CLASS_LABELS[c] }}
            </button>
          </div>
        </div>
      </template>
    </template>

    <button
      type="button"
      class="ld-disc"
      :aria-expanded="open === 'never'"
      @click="toggle('never')"
    >
      <svg
        class="ld-i ld-chev"
        viewBox="0 0 16 16"
        aria-hidden="true"
      ><path d="M6 3.5 10.5 8 6 12.5" /></svg>
      <b>Never-use list</b>
      <span class="ld-dim">{{ never.length ? `${never.length} model and effort ${never.length === 1 ? 'pair' : 'pairs'}` : 'Nothing blocked' }}</span>
    </button>
    <div
      v-if="open === 'never'"
      class="ld-never"
    >
      <div class="ld-row-wrap">
        <span
          v-for="b in never"
          :key="`${b.provider}/${b.model}/${b.effort}`"
          class="ld-chip"
        >{{ pairText(b) }} <span class="ld-dim">{{ providerName(state, b.provider) }}</span><button
          type="button"
          :aria-label="`Allow ${pairText(b)} again`"
          @click="removePair(b)"
        >×</button></span>
        <span
          v-if="!never.length"
          class="ld-dim"
        >No pairs yet.</span>
      </div>
      <form
        v-if="pairProviders.length"
        class="ld-row-wrap ld-pair"
        @submit.prevent="addBuiltPair"
      >
        <span class="ld-dim">Never use</span>
        <select
          v-model="pairProvider"
          class="sel sm"
          aria-label="Provider"
        >
          <option
            v-for="p in pairProviders"
            :key="p.id"
            :value="p.id"
          >
            {{ providerName(state, p.id) }}
          </option>
        </select>
        <select
          v-model="pairModel"
          class="sel sm"
          aria-label="Model"
        >
          <option
            v-for="x in pairModels"
            :key="x.id"
            :value="x.id"
          >
            {{ x.label || x.id }}
          </option>
        </select>
        <span class="ld-dim">at</span>
        <select
          v-model="pairEffort"
          class="sel sm"
          aria-label="Effort"
        >
          <option value="any">
            Any effort
          </option>
          <option
            v-for="l in pairLevels"
            :key="l.id"
            :value="l.id"
          >
            {{ effortLabel(l.id) }}
          </option>
        </select>
        <button
          type="submit"
          class="btn sm"
        >
          Add pair
        </button>
      </form>
      <p class="ld-dim">
        A role entry that would run a blocked pair is skipped. An entry left on Default counts as the model's default level.
      </p>
    </div>

    <Teleport to="body">
      <div
        v-if="dirty"
        class="ld-bar"
        role="region"
        aria-label="Unsaved changes"
      >
        <div class="ld-bar-c">
          <b>{{ pending.length }} unsaved {{ pending.length === 1 ? 'change' : 'changes' }}</b>
          <span>Nothing applies until you save.</span>
        </div>
        <ol>
          <li
            v-for="(x, n) in pending"
            :key="n"
            :title="x"
          >
            {{ x }}
          </li>
        </ol>
        <div class="ld-bar-a">
          <button
            type="button"
            class="ld-btn"
            @click="discard"
          >
            Discard
          </button>
          <button
            type="button"
            class="ld-btn ld-btn-pri"
            @click="save"
          >
            Save changes
          </button>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped lang="scss">
.ld { padding: 0; overflow: visible; container-type: inline-size; }
.ac { color: var(--accent-primary); }
.ld-short { display: none; }
/* The settings pane is often under 1000px wide: keep each line on one row with short effort names. */
@container (max-width: 1000px) {
  .ld-full { display: none; }
  .ld-short { display: inline; }
  .ld-seg button { padding: 0 7px; }
  .ld-grid { --eff: 340px; }
  .ld-det { grid-template-columns: minmax(0, 1fr); gap: 4px; }
  .ld-acts { justify-content: flex-start; padding-top: 4px; }
}
.ld-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; padding: 16px 20px 14px; border-bottom: 1px solid var(--border-subtle); }
.ld-head h2 { margin: 0; }
.ld-head p { margin: 3px 0 0; color: var(--text-muted); max-width: 72ch; }
.ld-head-r { display: flex; align-items: center; gap: 12px; white-space: nowrap; padding-top: 2px; }
.ld-count { font-size: 12px; font-weight: 600; border-radius: 999px; padding: 1px 9px; background: var(--status-warning-soft); color: color-mix(in srgb, var(--status-warning) 80%, var(--text-primary)); }
.ld-dim { color: var(--text-dim); font-size: 12px; }
.ld-i { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }

/* A fixed effort column keeps every role's model boxes the same width, whatever levels a model offers. */
.ld-grid { --eff: 480px; display: grid; grid-template-columns: 22px minmax(96px, 150px) minmax(170px, 1fr) var(--eff) 48px; gap: 0 12px; align-items: center; padding: 0 20px; }
.ld-colhead { height: 28px; font-size: 12px; color: var(--text-dim); border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface-alt); }
.ld-role { display: flex; align-items: center; gap: 12px; height: 36px; padding: 0 12px 0 20px; background: var(--bg-surface-hover); border-bottom: 1px solid var(--border-subtle); }
.ld-role b { font-size: 14px; }
.ld-users { flex: 1; min-width: 0; color: var(--text-dim); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-ghost { border: 0; background: none; color: var(--text-muted); font: inherit; font-size: 12.5px; border-radius: 6px; padding: 3px 8px; }
.ld-ghost:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.ld-sub { padding: 10px 20px 12px 54px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface-alt); }
.ld-sub p { margin: 6px 0 0; }
.ld-row-wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }

.ld-line { min-height: 44px; border-bottom: 1px solid var(--border-subtle); }
.ld-line.bad { background: var(--status-warning-soft); border-bottom-color: transparent; }
.ld-line.open:not(.bad) { border-bottom-color: transparent; }
.ld-empty-t { grid-column: 2 / -1; }
.ld-empty { margin: 0; color: color-mix(in srgb, var(--status-warning) 80%, var(--text-primary)); font-size: 12.5px; }
.ld-ord { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: var(--bg-surface-hover); color: var(--text-muted); font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums; }
.ld-prov b { display: block; font-weight: 600; }
.ld-prov small { display: block; color: var(--text-dim); font-size: 11px; line-height: 1.25; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-model-wrap { position: relative; min-width: 0; }
.ld-model {
  display: flex; align-items: center; gap: 6px; width: 100%; height: 30px; padding: 0 8px 0 10px; border: 1px solid var(--border-default);
  border-radius: 6px; background: var(--bg-surface); color: var(--text-primary); font: inherit; font-weight: 600; text-align: left;
}
.ld-model:hover { border-color: var(--text-dim); }
.ld-model.ed { border-color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 12%, var(--bg-surface)); }
.ld-model.bad { border-color: color-mix(in srgb, var(--status-warning) 80%, transparent); color: color-mix(in srgb, var(--status-warning) 85%, var(--text-primary)); }
.ld-model.bad .ld-lbl { text-decoration: line-through; }
.ld-lbl { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-model .ld-i { color: var(--text-dim); }

.ld-seg { display: inline-flex; flex-wrap: nowrap; justify-self: start; border: 1px solid var(--border-default); border-radius: 6px; overflow: hidden; background: var(--bg-surface); }
.ld-seg button { border: 0; border-left: 1px solid var(--border-subtle); background: none; height: 28px; padding: 0 9px; font: inherit; font-size: 12px; color: var(--text-muted); white-space: nowrap; }
.ld-seg button:first-child { border-left: 0; }
.ld-seg button:hover:not(:disabled):not([aria-checked=true]) { background: var(--bg-surface-hover); color: var(--text-primary); }
.ld-seg button[aria-checked=true] { background: color-mix(in srgb, var(--accent-primary) 30%, var(--bg-surface)); color: var(--text-primary); font-weight: 600; }
.ld-seg.ed { border-color: var(--accent-primary); }
.ld-seg.ed button[aria-checked=true] { background: var(--accent-primary); color: var(--bg-surface); }
.ld-seg button:disabled { opacity: .45; text-decoration: line-through; cursor: default; }
.ld-seg button.badsel { background: var(--status-warning); color: var(--bg-surface); text-decoration: line-through; }
.ld-seg > .ld-dim { padding: 0 9px; line-height: 28px; }
.ld-dft { font-weight: 400; opacity: .85; }
.ld-more { justify-self: end; }

.ld-menu {
  position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; width: 330px; max-height: 380px; display: flex; flex-direction: column;
  background: var(--bg-surface); border: 1px solid var(--border-default); border-radius: 8px; box-shadow: var(--elev-float); overflow: hidden;
}
.ld-menu-q { padding: 8px; border-bottom: 1px solid var(--border-subtle); }
.ld-menu-q input { width: 100%; }
.ld-menu-list { overflow-y: auto; padding: 4px; }
.ld-opt { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 30px; padding: 4px 8px; border: 0; border-radius: 5px; background: none; color: var(--text-primary); font: inherit; text-align: left; }
button.ld-opt:hover:not(:disabled) { background: var(--bg-surface-hover); }
.ld-opt.cur { font-weight: 600; background: color-mix(in srgb, var(--accent-primary) 14%, var(--bg-surface)); }
.ld-opt:disabled { color: var(--text-dim); cursor: default; }
.ld-opt.gone { color: color-mix(in srgb, var(--status-warning) 85%, var(--text-primary)); }
.ld-opt-n { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-tag { font-size: 11px; line-height: 16px; padding: 0 5px; border-radius: 4px; background: var(--bg-surface-hover); color: var(--text-muted); white-space: nowrap; }
.ld-tag.new { background: var(--status-success-soft); color: var(--status-success); }
.ld-tag.warn { background: var(--status-warning-soft); color: color-mix(in srgb, var(--status-warning) 85%, var(--text-primary)); }
.ld-menu-note { margin: 0; padding: 6px 8px; color: var(--text-dim); font-size: 12px; }
.ld-menu-foot { margin: 0; padding: 7px 10px; border-top: 1px solid var(--border-subtle); color: var(--text-dim); font-size: 12px; }

.ld-prob { padding: 0 20px 10px 54px; background: var(--status-warning-soft); border-bottom: 1px solid var(--border-subtle); }
.ld-prob-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; color: color-mix(in srgb, var(--status-warning) 85%, var(--text-primary)); font-size: 12.5px; }
.ld-prob-row + .ld-prob-row { margin-top: 6px; }
.ld-fix { height: 24px; padding: 0 9px; border: 0; border-radius: 6px; background: var(--status-warning); color: var(--bg-surface); font: inherit; font-size: 12px; font-weight: 600; }

.ld-det { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 24px; padding: 4px 20px 14px 54px; border-bottom: 1px solid var(--border-subtle); background: var(--bg-surface-alt); }
.ld-det h4 { margin: 8px 0 6px; font-size: 12px; font-weight: 600; color: var(--text-dim); }
.ld-rules { display: grid; gap: 4px; }
.ld-rules label { display: flex; align-items: center; gap: 8px; min-height: 26px; cursor: pointer; }
.ld-rules input[type=radio] { accent-color: var(--accent-primary); margin: 0; }
.ld-rule-in { width: 120px; }
.ld-acts { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: flex-start; gap: 6px; padding-top: 24px; }
.ld-rm:hover { color: var(--status-error); background: var(--status-error-soft); }

.ld-disc { display: flex; align-items: center; gap: 8px; width: 100%; padding: 11px 20px; border: 0; background: none; color: var(--text-muted); font: inherit; text-align: left; }
.ld-disc:hover { background: var(--bg-surface-hover); color: var(--text-primary); }
.ld-disc b { color: var(--text-primary); font-weight: 600; }
.ld-chev { transition: transform 180ms cubic-bezier(.22, 1, .36, 1); }
.ld-disc[aria-expanded=true] .ld-chev { transform: rotate(90deg); }
.ld-never { display: grid; gap: 10px; padding: 2px 20px 16px 42px; }
.ld-never p { margin: 0; }
.ld-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 4px 0 10px; border: 1px solid color-mix(in srgb, var(--status-error) 40%, transparent); border-radius: 13px; background: var(--status-error-soft); font-size: 12px; }
.ld-chip button { width: 18px; height: 18px; border: 0; border-radius: 50%; background: none; color: inherit; padding: 0; }
.ld-chip button:hover { background: var(--bg-surface-hover); }
.ld-pair select { max-width: 220px; }

.ld-bar {
  /* Fixed to the window so it is on screen wherever the change was made. */
  position: fixed; right: 24px; bottom: 40px; z-index: 60; width: min(820px, calc(100vw - 48px));
  display: flex; align-items: center; gap: 20px; padding: 10px 12px 10px 16px; color: var(--text-primary);
  border: 1px solid var(--accent-primary); border-radius: 10px; background: var(--bg-surface); box-shadow: var(--elev-float);
}
.ld-bar-c { white-space: nowrap; }
.ld-bar-c b { display: block; }
.ld-bar-c span { color: var(--text-muted); font-size: 12px; }
.ld-bar ol { flex: 1; min-width: 0; max-height: 60px; overflow: auto; margin: 0; padding: 0 0 0 20px; color: var(--text-muted); font-size: 12px; line-height: 20px; columns: 2; column-gap: 28px; }
.ld-bar li { break-inside: avoid; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ld-bar-a { display: flex; gap: 8px; flex: none; }
/* The bar sits outside the settings page (it is fixed to the window), so it carries its own button styles. */
.ld-btn {
  height: 32px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--border-default); background: var(--bg-surface-hover);
  color: var(--text-primary); font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background 150ms cubic-bezier(.22, 1, .36, 1), border-color 150ms cubic-bezier(.22, 1, .36, 1);
}
.ld-btn:hover { border-color: var(--text-dim); }
.ld-btn:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.ld-btn-pri { background: var(--accent-primary); border-color: var(--accent-primary); color: var(--bg-surface); }
.ld-btn-pri:hover { filter: brightness(1.08); border-color: var(--accent-primary); }
@media (prefers-reduced-motion: reduce) { .ld-chev { transition: none; } }
</style>
