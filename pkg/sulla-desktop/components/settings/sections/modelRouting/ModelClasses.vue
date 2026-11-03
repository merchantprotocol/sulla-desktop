<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/**
 * Models in each class: one ordered {provider, model} list per class, in an
 * accordion. Follow provider order or a custom order (dragging or moving a
 * row switches to custom), add/remove models, reset to recommended.
 */
import { computed, nextTick, onBeforeUnmount, reactive, ref } from 'vue';

import RoutingIcon from './RoutingIcon.vue';
import { animateIn, animateOut, flip, placePopover, rowByKey, startDrag } from './routingDom';
import {
  addModelGroups, availability, CLASS_DESCRIPTIONS, CLASS_FALLBACK, CLASS_LABELS, classIsRecommended, classNow, classSummary, emptyClassText, modelKey,
  modelName, orderedClassModels, providerChip, providerLetter, providerName, sortByProviderOrder,
} from './routingLogic';
import { MODEL_CLASSES, type ClassModel, type ModelClass, type ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';

const props = defineProps<{ state: ModelRoutingState; now: number }>();
const emit = defineEmits<{
  /** New ordered model list for a class and whether it follows provider order. */
  (e: 'change', modelClass: ModelClass, models: ClassModel[], follow: boolean): void;
  (e: 'reset', modelClass: ModelClass): void;
  (e: 'toast', message: string): void;
}>();

const ROW = '.mr-mrow';
const root = ref<HTMLElement | null>(null);
const catsEl = ref<HTMLElement | null>(null);
const pop = ref<HTMLElement | null>(null);
const open = reactive(new Set<ModelClass>(['frontier']));
const picking = ref<ModelClass | null>(null);
let pickBtn: HTMLElement | null = null;

const models = computed(() => Object.fromEntries(MODEL_CLASSES.map(c => [c, orderedClassModels(props.state, c)])) as Record<ModelClass, ClassModel[]>);
const groups = computed(() => picking.value ? addModelGroups(props.state, picking.value) : []);

function key(c: ModelClass, m: ClassModel) { return `${ c }|${ modelKey(m) }`; }
function toggleOpen(c: ModelClass) { if (open.has(c)) open.delete(c); else open.add(c); }
function fallbackNote(c: ModelClass) { const fb = CLASS_FALLBACK[c]; return fb ? `If this list is empty, ${ CLASS_LABELS[c] } falls back to ${ CLASS_LABELS[fb] }.` : 'Local has no fallback, so nothing leaves this Mac.'; }

function change(c: ModelClass, next: ClassModel[], follow: boolean) {
  return flip(catsEl.value, ROW, () => emit('change', c, follow ? sortByProviderOrder(props.state, next) : next, follow));
}
function goingCustom(c: ModelClass) {
  if (props.state.followProviderOrder[c]) emit('toast', `${ CLASS_LABELS[c] } now uses a custom order. Reordering the Agents list won’t re-sort it.`);
}
async function move(c: ModelClass, i: number, delta: number, from: 'grip' | 'button') {
  const list = models.value[c]; const j = i + delta;
  if (j < 0 || j >= list.length) return;
  goingCustom(c);
  const k = key(c, list[i]); const next = [...list]; const [m] = next.splice(i, 1); next.splice(j, 0, m);
  await change(c, next, false);
  const el = rowByKey(catsEl.value, ROW, k);
  (from === 'grip' ? el?.querySelector<HTMLElement>('.mr-grip') : (el?.querySelector<HTMLElement>(`[data-mv="${ delta }"]:not(:disabled)`) ?? el?.querySelector<HTMLElement>('.mr-grip')))?.focus();
}
function onDrag(c: ModelClass, e: PointerEvent) {
  const list = (e.currentTarget as HTMLElement | null)?.closest<HTMLElement>('.mr-mlist');
  if (!list) return;
  startDrag(e, {
    list, selector: ROW,
    onDrop: (from, to) => { goingCustom(c); const next = [...models.value[c]]; const [m] = next.splice(from, 1); next.splice(to, 0, m); emit('change', c, next, false); },
  });
}
async function remove(c: ModelClass, i: number) {
  const m = models.value[c][i];
  await animateOut(rowByKey(catsEl.value, ROW, key(c, m)));
  await change(c, models.value[c].filter((_, n) => n !== i), props.state.followProviderOrder[c]);
  const next = catsEl.value?.querySelector<HTMLElement>(`.mr-cat[data-cat="${ c }"] .mr-rm`) ?? catsEl.value?.querySelector<HTMLElement>(`.mr-cat[data-cat="${ c }"] [data-add]`);
  next?.focus({ preventScroll: true });
}
function setFollow(c: ModelClass, follow: boolean) {
  if (props.state.followProviderOrder[c] === follow) return;
  void change(c, models.value[c], follow);
}

// Add model picker
function onOutside(e: PointerEvent) { const t = e.target as Node; if (!pop.value?.contains(t) && !pickBtn?.contains(t)) closePicker(); }
async function openPicker(c: ModelClass, e: MouseEvent) {
  const btn = e.currentTarget as HTMLElement;
  if (picking.value === c) return closePicker(true);
  closePicker();
  picking.value = c; pickBtn = btn;
  await nextTick();
  if (pop.value && root.value) placePopover(pop.value, btn, root.value);
  (pop.value?.querySelector<HTMLElement>('.mr-pi:not(:disabled)') ?? pop.value)?.focus();
  document.addEventListener('pointerdown', onOutside, true);
}
function closePicker(refocus = false) {
  if (!picking.value) return;
  picking.value = null;
  document.removeEventListener('pointerdown', onOutside, true);
  if (refocus) pickBtn?.focus({ preventScroll: true });
}
async function addModel(provider: string, model: string) {
  const c = picking.value; if (!c) return;
  closePicker();
  const item = { provider, model };
  await change(c, [...models.value[c], item], props.state.followProviderOrder[c]);
  const el = rowByKey(catsEl.value, ROW, key(c, item));
  animateIn(el); el?.querySelector<HTMLElement>('.mr-grip')?.focus({ preventScroll: true });
}
function chipNoTime(provider: string) { const c = providerChip(props.state, provider, props.now); return { ...c, label: c.label.replace(/ until .+$/, '') }; }
onBeforeUnmount(() => document.removeEventListener('pointerdown', onOutside, true));
</script>

<template>
  <section
    ref="root"
    class="card mr-card"
    :class="{ picking: !!picking }"
    aria-label="Models in each class"
  >
    <div class="card-h">
      <div>
        <h2>Models in each class</h2>
        <p>What each class means for each provider. A row above uses its provider’s first ready model here. An agent that asks for a class directly walks the whole list.</p>
      </div>
    </div>
    <ul
      ref="catsEl"
      class="mr-cats"
    >
      <li
        v-for="c in MODEL_CLASSES"
        :key="c"
        class="mr-cat"
        :class="{ open: open.has(c) }"
        :data-cat="c"
      >
        <button
          type="button"
          class="mr-cat-h"
          :aria-expanded="open.has(c)"
          :aria-controls="`mr-cb-${ c }`"
          @click="toggleOpen(c)"
        >
          <RoutingIcon name="chev" />
          <span class="mr-ct">
            <b>{{ CLASS_LABELS[c] }}</b><span class="mr-cp">{{ CLASS_DESCRIPTIONS[c] }}</span>
            <span class="mr-sum">
              <template v-if="models[c].length">
                <template
                  v-for="(part, n) in classSummary(state, c, now)"
                  :key="n"
                ><em v-if="n">→</em><s
                  v-if="part.out"
                  title="Skipped right now"
                >{{ part.label }}</s><template v-else>{{ part.label }}</template></template>
              </template>
              <span
                v-else
                class="mr-se"
              >{{ CLASS_FALLBACK[c] ? `Empty · falls back to ${ CLASS_LABELS[CLASS_FALLBACK[c]!] }` : 'Empty · no fallback' }}</span>
            </span>
          </span>
          <span
            class="mr-cnow"
            :title="`What an agent asking for ${ CLASS_LABELS[c] } gets right now`"
          >
            <span
              class="mr-dot"
              :class="classNow(state, c, now).kind"
            />
            <b v-if="classNow(state, c, now).bold">{{ classNow(state, c, now).label }}</b>
            <template v-else>{{ classNow(state, c, now).label }}</template>
          </span>
        </button>
        <div
          :id="`mr-cb-${ c }`"
          class="mr-cat-b"
          v-bind="open.has(c) ? {} : { inert: '' }"
        >
          <div>
            <div class="mr-cat-in">
              <div class="mr-ctools">
                <div
                  class="seg mr-seg"
                  role="radiogroup"
                  :aria-label="`${ CLASS_LABELS[c] } order`"
                >
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="state.followProviderOrder[c]"
                    :class="{ on: state.followProviderOrder[c] }"
                    @click="setFollow(c, true)"
                  >
                    Follow provider order
                  </button>
                  <button
                    type="button"
                    role="radio"
                    :aria-checked="!state.followProviderOrder[c]"
                    :class="{ on: !state.followProviderOrder[c] }"
                    @click="setFollow(c, false)"
                  >
                    Custom order
                  </button>
                </div>
                <span class="mr-chelp">{{ state.followProviderOrder[c] ? 'Sorted by your Agents list.' : 'Your order. Reordering the Agents list won’t change it.' }}</span>
                <button
                  type="button"
                  class="link mr-link"
                  :disabled="classIsRecommended(state, c)"
                  :title="classIsRecommended(state, c) ? 'Already on the recommended models' : undefined"
                  @click="emit('reset', c)"
                >
                  Reset to recommended
                </button>
              </div>
              <ol
                v-if="models[c].length"
                class="mr-mlist"
                :aria-label="`${ CLASS_LABELS[c] } models, in the order Sulla tries them`"
              >
                <li
                  v-for="(m, i) in models[c]"
                  :key="key(c, m)"
                  :data-key="key(c, m)"
                  class="mr-mrow"
                  :class="{ out: !availability(state, m.provider, now).ok }"
                >
                  <button
                    type="button"
                    class="mr-grip"
                    :aria-label="`Drag to reorder ${ modelName(state, m.provider, m.model) }. Use the up and down arrow keys to move it.`"
                    title="Drag to reorder"
                    @pointerdown="onDrag(c, $event)"
                    @keydown.up.prevent="move(c, i, -1, 'grip')"
                    @keydown.down.prevent="move(c, i, 1, 'grip')"
                  >
                    <RoutingIcon name="grip" />
                  </button>
                  <span class="mr-rank">{{ i + 1 }}</span>
                  <span
                    class="mr-logo"
                    aria-hidden="true"
                  >{{ providerLetter(state, m.provider) }}</span>
                  <span class="mr-mname">
                    <b :title="m.model">{{ modelName(state, m.provider, m.model) }}</b>
                    <span class="mr-pb">{{ providerName(state, m.provider) }}</span>
                    <span
                      v-if="classNow(state, c, now).inUse === modelKey(m)"
                      class="mr-now"
                    >In use now</span>
                  </span>
                  <span
                    class="mr-chip"
                    :class="providerChip(state, m.provider, now).kind"
                  ><i />{{ providerChip(state, m.provider, now).label }}</span>
                  <span class="mr-moves">
                    <button
                      type="button"
                      class="mr-ib"
                      data-mv="-1"
                      :aria-label="`Move ${ modelName(state, m.provider, m.model) } up`"
                      :disabled="i === 0"
                      @click="move(c, i, -1, 'button')"
                    ><RoutingIcon name="up" /></button>
                    <button
                      type="button"
                      class="mr-ib"
                      data-mv="1"
                      :aria-label="`Move ${ modelName(state, m.provider, m.model) } down`"
                      :disabled="i === models[c].length - 1"
                      @click="move(c, i, 1, 'button')"
                    ><RoutingIcon name="down" /></button>
                  </span>
                  <button
                    type="button"
                    class="mr-ib mr-rm"
                    :aria-label="`Remove ${ modelName(state, m.provider, m.model) } (${ providerName(state, m.provider) }) from ${ CLASS_LABELS[c] }`"
                    title="Remove"
                    @click="remove(c, i)"
                  ><RoutingIcon name="x" /></button>
                </li>
              </ol>
              <div
                v-else
                class="mr-mempty"
              >
                <RoutingIcon name="info" /><span>{{ emptyClassText(c) }}</span>
              </div>
              <div class="mr-cfoot">
                <button
                  type="button"
                  class="btn sm"
                  data-add
                  aria-haspopup="dialog"
                  :aria-expanded="picking === c"
                  @click="openPicker(c, $event)"
                >
                  <RoutingIcon name="plus" />Add model
                </button>
                <span class="mr-fb">{{ fallbackNote(c) }}</span>
              </div>
            </div>
          </div>
        </div>
      </li>
    </ul>

    <div
      v-if="picking"
      ref="pop"
      class="mr-picker"
      role="dialog"
      tabindex="-1"
      :aria-label="`Add a ${ CLASS_LABELS[picking] } model`"
      @keydown.esc.stop.prevent="closePicker(true)"
    >
      <div class="mr-pk-h">
        <b>Add a {{ CLASS_LABELS[picking] }} model</b>
        <small>{{ picking === 'local' ? 'Only providers that run on this Mac.' : 'Connected providers only, in your Agents order.' }}</small>
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
            v-for="m in g.models"
            :key="m.id"
            type="button"
            class="mr-pi"
            :disabled="m.added"
            @click="addModel(g.provider.id, m.id)"
          >
            <span>{{ m.label }}</span>
            <code v-if="m.added"><RoutingIcon name="check" />Added</code>
            <code v-else>{{ m.id }}</code>
          </button>
        </div>
        <div
          v-if="!groups.length"
          class="mr-pk-none"
        >
          {{ picking === 'local' ? 'Connect Ollama to add models that run on this Mac.' : 'Connect a provider to add models.' }}
        </div>
      </div>
    </div>
  </section>
</template>
