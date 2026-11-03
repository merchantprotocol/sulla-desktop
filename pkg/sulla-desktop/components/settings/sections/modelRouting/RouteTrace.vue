<!--
  Sulla Desktop · https://sulladesktop.com
  Copyright (c) 2025-2026 Merchant Protocol LLC.
  SPDX-License-Identifier: GPL-2.0-or-later
  "Sulla" is a trademark. See TRADEMARK.md.
-->
<script setup lang="ts">
/** How a request is routed: the rule, plus a live trace computed from the lists and provider status. */
import { computed, ref } from 'vue';

import RoutingIcon from './RoutingIcon.vue';
import {
  CLASS_LABELS, findProvider, formatClock, modelName, providerLetter, providerName, traceRoute, type RoutingListKey, type TraceStep,
} from './routingLogic';
import type { ModelRoutingState } from '@pkg/agent/languagemodels/modelRoutingTypes';

const props = defineProps<{ state: ModelRoutingState; now: number }>();
const list = ref<RoutingListKey>('agents');

const WHO: Record<RoutingListKey, [string, string]> = { agents: ['Code Reviewer', 'reviewing a pull request'], subconscious: ['Memory curator', 'organizing this conversation'] };
const listName = computed(() => list.value === 'agents' ? 'Agents' : 'Subconscious');
const rows = computed(() => list.value === 'agents' ? props.state.agentsList : props.state.subconsciousList);
const trace = computed(() => traceRoute(props.state, list.value, props.now));
const other = computed(() => list.value === 'agents' ? props.state.subconsciousList : props.state.agentsList);
/** Changes whenever the walk changes, so the steps replay their entrance. */
const signature = computed(() => `${ list.value }|${ trace.value.steps.map(s => `${ s.index }${ s.kind }${ s.model?.model ?? '' }`).join(',') }|${ trace.value.next?.index ?? '' }`);

function name(id: string) { return providerName(props.state, id); }
function rowTag(s: TraceStep) { return `${ name(s.row.provider) } · ${ CLASS_LABELS[s.row.class] }`; }
function title(s: TraceStep) { return s.model ? modelName(props.state, s.model.provider, s.model.model) : rowTag(s); }
function stepClass(s: TraceStep) { return s.kind === 'use' ? 'use' : `pass ${ s.kind === 'cool' ? 'cool' : s.kind === 'err' ? 'err' : 'off' }`; }
function until(provider: string) { return formatClock(findProvider(props.state, provider)?.coolingUntil); }
const both = computed(() => !!trace.value.chosen && other.value.some(r => r.provider === trace.value.chosen!.row.provider));
</script>

<template>
  <section
    class="card mr-card"
    aria-label="How a request is routed"
  >
    <div class="card-h">
      <div>
        <h2>How a request is routed</h2>
        <p>Live, from your lists and the status of each provider right now.</p>
      </div>
    </div>
    <div class="mr-route">
      <p class="mr-rule">
        A request walks its list top to bottom: <b>Agents</b> for main agents, <b>Subconscious</b> for background ones.
        Each row turns its provider and class into that provider’s first ready model in the class. Sulla skips rows that are
        turned off, have no model in their class, or whose provider is cooling down or erroring, and <b>uses the first ready row</b>.
        If that row hits a usage limit, its provider cools down in both lists and Sulla moves to the next row. Once the limit
        resets, it starts from the top again.
      </p>
      <div class="mr-ask">
        <div
          class="seg mr-seg"
          role="tablist"
          aria-label="Example to trace"
        >
          <button
            type="button"
            role="tab"
            :aria-selected="list === 'agents'"
            :class="{ on: list === 'agents' }"
            @click="list = 'agents'"
          >
            Agent
          </button>
          <button
            type="button"
            role="tab"
            :aria-selected="list === 'subconscious'"
            :class="{ on: list === 'subconscious' }"
            @click="list = 'subconscious'"
          >
            Subconscious
          </button>
        </div>
        <span class="mr-who-line"><b>{{ WHO[list][0] }}</b> is {{ WHO[list][1] }} and walks the <b>{{ listName }}</b> list</span>
      </div>
      <ol
        :key="signature"
        class="mr-path"
        aria-live="polite"
      >
        <li
          v-if="!rows.length"
          class="mr-step empty"
        >
          <div class="mr-sbox">
            <RoutingIcon name="info" /><span><b>{{ listName }} is empty</b><small>Add a provider to this list</small></span>
          </div>
        </li>
        <li
          v-for="(s, n) in trace.steps"
          :key="s.index"
          class="mr-step"
          :class="stepClass(s)"
          :style="{ animationDelay: `${ n * 50 }ms` }"
        >
          <div class="mr-sbox">
            <span
              class="mr-logo"
              aria-hidden="true"
            >{{ providerLetter(state, s.row.provider) }}</span>
            <span>
              <b>{{ title(s) }}</b>
              <small v-if="s.kind === 'use'">Row {{ s.index + 1 }} · {{ rowTag(s) }} · {{ s.model?.model }}</small>
              <small v-else>Row {{ s.index + 1 }} · {{ s.model ? `${ rowTag(s) } · ` : '' }}{{ s.why }}</small>
            </span>
            <RoutingIcon
              v-if="s.kind === 'use'"
              name="check"
              class="mr-ok-i"
            />
          </div>
        </li>
        <li
          v-if="trace.chosen && trace.next"
          class="mr-step next"
          :style="{ animationDelay: `${ trace.steps.length * 50 }ms` }"
        >
          <div class="mr-sbox">
            <span
              class="mr-logo"
              aria-hidden="true"
            >{{ providerLetter(state, trace.next.row.provider) }}</span>
            <span><b>Then {{ trace.next.model ? modelName(state, trace.next.model.provider, trace.next.model.model) : rowTag(trace.next) }}</b><small>Row {{ trace.next.index + 1 }} · if {{ name(trace.chosen.row.provider) }} hits a limit</small></span>
          </div>
        </li>
        <li
          v-if="!trace.chosen && trace.waits.length"
          class="mr-step wait"
          :style="{ animationDelay: `${ trace.steps.length * 50 }ms` }"
        >
          <div class="mr-sbox">
            <RoutingIcon name="clock" /><span><b>Waits</b><small>Retries {{ name(trace.waits[0].row.provider) }} at {{ until(trace.waits[0].row.provider) }}</small></span>
          </div>
        </li>
      </ol>
      <div class="mr-after">
        <template v-if="trace.chosen && trace.waits.length">
          <RoutingIcon name="clock" /><span>Uses {{ title(trace.chosen) }} until {{ name(trace.waits[0].row.provider) }}’s limit resets at {{ until(trace.waits[0].row.provider) }}, then starts from the top of the {{ listName }} list again.</span>
        </template>
        <template v-else-if="trace.chosen">
          <RoutingIcon name="check" /><span>{{ trace.steps.length > 1 ? 'Rows above it are passed over only while they can’t run.' : `The top of the ${ listName } list is ready.` }}
            On a usage limit, {{ name(trace.chosen.row.provider) }} cools down{{ both ? ' in both lists' : '' }} and Sulla moves to the next row.</span>
        </template>
        <template v-else-if="trace.waits.length">
          <RoutingIcon name="info" /><span>Every row in {{ listName }} is unavailable right now. Add a provider that isn’t cooling down so this doesn’t wait.</span>
        </template>
        <template v-else>
          <RoutingIcon name="info" /><span>Nothing in {{ listName }} can run. Turn a row back on, add a provider, or connect another one.</span>
        </template>
      </div>
    </div>
  </section>
</template>
