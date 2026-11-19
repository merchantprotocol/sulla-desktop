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

import RoleLedgerBar from './RoleLedgerBar.vue';
import RoleLedgerDetail from './RoleLedgerDetail.vue';
import RoleLedgerEffort from './RoleLedgerEffort.vue';
import RoleLedgerMenu from './RoleLedgerMenu.vue';
import RoleLedgerNever from './RoleLedgerNever.vue';
import RoleLedgerProblems from './RoleLedgerProblems.vue';
import {
  addableProviders, chipChanged, chipHealth, effortLabel, effortLevels, effortUnsupported, firstUsableModel,
  isLevelBlocked, laneChanged, provenanceText, upgradeFor, usedBy, visibleRoles,
} from './laneLogic';
import { LedgerDrafts } from './ledgerDraft';
import { LedgerText } from './ledgerText';
import { CLASS_LABELS, modelSelectionLabel, orderedClassModels, providerKind, providerName } from './routingLogic';

import { effectiveEffort, isAutoEntry, isBlocked, resolveRule } from '@pkg/agent/languagemodels/modelCatalogRules';
import { MODEL_CLASSES, type ClassModel, type ModelClass, type ModelRoutingState, type ModelRule, type NeverUsePair } from '@pkg/agent/languagemodels/modelRoutingTypes';

type Patch = Pick<ModelRoutingState, 'classes' | 'followProviderOrder' | 'neverUse'>;
const props = defineProps<{ state: ModelRoutingState; now: number; refreshing: boolean }>();
const emit = defineEmits<{ (e: 'save', patch: Patch): void; (e: 'refresh'): void }>();

type Lanes = Record<ModelClass, ClassModel[]>;
function clone<T>(x: T): T { return JSON.parse(JSON.stringify(x)) }
function savedLanes(): Lanes { return Object.fromEntries(MODEL_CLASSES.map(c => [c, orderedClassModels(props.state, c)])) as Lanes }

const baseKey = () => JSON.stringify({ c: props.state.classes, n: props.state.neverUse ?? [], f: props.state.followProviderOrder });
const restored = LedgerDrafts.shared.take<Lanes, NeverUsePair[]>(baseKey());
const draft = ref<Lanes>(restored ? restored.lanes : savedLanes());
const never = ref<NeverUsePair[]>(restored ? restored.never : clone(props.state.neverUse ?? []));
const saved = computed(savedLanes);
const view = computed<ModelRoutingState>(() => ({ ...props.state, neverUse: never.value }));
const roles = computed(() => visibleRoles(props.state));
const changedRoles = computed(() => MODEL_CLASSES.filter(c => laneChanged(saved.value[c], draft.value[c])));
const neverChanged = computed(() => JSON.stringify(never.value) !== JSON.stringify(props.state.neverUse ?? []));
const dirty = computed(() => changedRoles.value.length > 0 || neverChanged.value);

watch([saved, () => props.state.neverUse], ([lanes, blocked], [previousLanes, previousBlocked]) => {
  // Compare to the previous saved values to distinguish actual edits from a refresh.
  for (const role of MODEL_CLASSES) {
    if (!laneChanged(previousLanes[role], draft.value[role])) draft.value[role] = [...lanes[role]];
  }
  if (JSON.stringify(never.value) === JSON.stringify(previousBlocked ?? [])) {
    never.value = clone(blocked ?? []);
  }
});

// ── Lookups ────────────────────────────────────────────────────────────────
const connected = (p: string) => !!props.state.providers.find(x => x.id === p)?.connected;
const modelsOf = (p: string) => props.state.providers.find(x => x.id === p)?.models ?? [];
const label = (p: string, model: string) => LedgerText.label(props.state, p, model);
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
  LedgerDrafts.shared.clear();
  open.value = '';
}

// ── Disclosure and the model menu ───────────────────────────────────────────
const open = ref('');
const toggle = (key: string) => { open.value = open.value === key ? '' : key };
const ruleText = ref<Record<string, string>>({});
const menu = ref<{ c: ModelClass; i: number; q: string } | null>(null);
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
  if (dirty.value) LedgerDrafts.shared.keep({ base: baseKey(), lanes: clone(draft.value), never: clone(never.value) });
});

const pending = computed(() => LedgerText.pending(props.state, saved.value, draft.value, never.value, changedRoles.value, connected));
function sourceText(c: ModelClass, i: number): string {
  return chipChanged(saved.value[c], draft.value[c], i) ? 'Unsaved' : provenanceText(props.state, c, draft.value[c][i]);
}
</script>

<template>
  <section
    class="card ld"
    :class="{ pend: dirty, 'ld-picking': !!menu }"
    aria-label="Models for each role"
  >
    <header class="ld-head">
      <div>
        <h2>Models for each role</h2>
        <p>Providers are tried in order.</p>
      </div>
      <div class="ld-head-r">
        <span
          v-if="problemCount"
          class="ld-count"
        >{{ problemCount }} to fix</span>
        <span
          class="ld-dim"
          aria-live="polite"
        >{{ refreshing ? 'Checking lists…' : `Lists checked ${LedgerText.ago(now, state.catalog?.checkedAt)}` }}</span>
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
          v-if="usedBy(state, c).length"
          :title="usedBy(state, c).join(', ')"
        >Used by {{ usedBy(state, c).slice(0, 2).join(', ') }}<template v-if="usedBy(state, c).length > 2"> +{{ usedBy(state, c).length - 2 }}</template></span>
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
          <span class="ld-dim">Available to add</span>
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
            Disconnected: {{ hiddenProviders(c).join(', ') }}.
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
        <span /><span class="ld-empty-t">No connected providers. Agents use another role.</span>
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
            <small :class="{ ac: sourceText(c, i) === 'Unsaved' }"><template v-if="sourceText(c, i) !== 'You chose'">{{ sourceText(c, i) }} · </template>{{ providerKind(state, m.provider) }}</small>
          </span>
          <span class="ld-model-wrap">
            <button
              type="button"
              class="ld-model"
              :class="{ bad: chipHealth(view, m) === 'unlisted' || chipHealth(view, m) === 'blocked', ed: edited(c, i, 'model') }"
              aria-haspopup="listbox"
              :aria-expanded="menu?.c === c && menu.i === i"
              :aria-label="`${providerName(state, m.provider)} model for ${CLASS_LABELS[c]}: ${label(m.provider, m.model)} (${modelSelectionLabel(state, m.provider, m.model)})`"
              :title="modelSelectionLabel(state, m.provider, m.model)"
              @click="openMenu(c, i)"
            >
              <span class="ld-lbl">{{ label(m.provider, m.model) }}</span>
              <svg
                class="ld-i"
                viewBox="0 0 16 16"
                aria-hidden="true"
              ><path d="M4 6l4 4 4-4" /></svg>
            </button>
            <RoleLedgerMenu
              v-if="menu?.c === c && menu.i === i"
              v-model:query="menu.q"
              :state="state"
              :view="view"
              :never="never"
              :m="m"
              :models="menuModels"
              @pick="id => { pick(c, i, id); closePop() }"
            />
          </span>
          <RoleLedgerEffort
            :state="state"
            :view="view"
            :m="m"
            :role="CLASS_LABELS[c]"
            :edited="edited(c, i, 'effort')"
            @set="effort => setEffort(c, i, effort)"
          />
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

        <RoleLedgerProblems
          v-if="problems(c, i).length"
          :problems="problems(c, i)"
        />

        <RoleLedgerDetail
          v-if="open === `line:${c}:${i}`"
          :state="state"
          :m="m"
          :role="c"
          :index="i"
          :shown="k"
          :count="lines(c).length"
          :rule-text="ruleText[`${c}:${i}`]"
          :preview="rule => rulePreview(c, i, rule)"
          @update:rule-text="text => { ruleText[`${c}:${i}`] = text }"
          @pick="model => pick(c, i, model)"
          @rule="rule => useRule(c, i, rule)"
          @move="delta => move(c, i, delta)"
          @never="addPair"
          @remove="remove(c, i)"
        />
      </template>
    </template>

    <RoleLedgerNever
      :state="state"
      :never="never"
      :open="open === 'never'"
      @toggle="toggle('never')"
      @add="addPair"
      @remove="removePair"
    />

    <RoleLedgerBar
      v-if="dirty"
      :pending="pending"
      @discard="discard"
      @save="save"
    />
  </section>
</template>

<style scoped src="./RoleLedger.css"></style>
