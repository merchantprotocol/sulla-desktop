<template>
  <section class="decide-page">
    <header class="decide-hero">
      <div><span class="decide-eyebrow">Decision desk</span><h1>Decide with confidence.</h1><p>{{ pending.length }} waiting on you</p></div>
      <button
        type="button"
        @click="openSettings"
      >
        Approval settings
      </button>
      <button
        type="button"
        @click="refresh"
      >
        Refresh
      </button>
    </header>
    <p
      v-if="error || actionError"
      role="alert"
    >
      {{ actionError || error }}
    </p>
    <template v-if="settings">
      <header>
        <h2>Tool approval settings</h2><button
          type="button"
          @click="settings = false"
        >
          Back to decisions
        </button>
      </header>
      <p>Selected tools wait for your approval before running. This applies to the Sulla tool catalog; shell commands and provider-native tools are outside this policy.</p>
      <input
        v-model="search"
        type="search"
        placeholder="Find a tool or category"
        aria-label="Find a tool or category"
      >
      <section
        v-for="category in categories"
        :key="category"
        class="decision"
      >
        <h3>{{ category }}</h3>
        <label
          v-for="tool in filtered.filter(t => t.category === category)"
          :key="tool.name"
          class="policy"
        >
          <input
            type="checkbox"
            :checked="tool.required"
            :disabled="!!busy"
            @change="setPolicy(tool, ($event.target as HTMLInputElement).checked)"
          >
          <span><strong>{{ tool.name }}</strong><small>{{ tool.description }}</small></span>
        </label>
      </section>
    </template>
    <template v-else>
      <p v-if="!records.length && !error">
        Nothing waiting on you. Requests appear here when an agent needs your decision.
      </p>
      <article
        v-for="item in records"
        :key="item.id"
        class="decision"
        :class="`decision-${item.status}`"
      >
        <header><h2>{{ item.title }}</h2><span>{{ item.status }}</span></header>
        <p>Conversation {{ item.conversationId }} · {{ new Date(item.createdAt).toLocaleString() }}</p>
        <p v-if="item.kind === 'approval'">
          Review the original tool call before approving. Approval resumes only that waiting call.
        </p>
        <template v-if="['pending', 'deferred'].includes(item.status)">
          <fieldset
            v-for="(question, index) in item.questions || []"
            :key="index"
          >
            <legend>{{ question.question }}</legend>
            <label
              v-for="option in question.options"
              :key="option.label"
              class="option"
            >
              <input
                :type="question.multiSelect ? 'checkbox' : 'radio'"
                :name="`${item.id}-${index}`"
                :checked="selected(item.id, index).includes(option.label)"
                @change="select(item.id, index, option.label, !!question.multiSelect)"
              >
              {{ option.label }} <small>{{ option.description }}</small>
            </label>
            <input
              :value="other[item.id + ':' + index] || ''"
              aria-label="Your own answer"
              placeholder="Your own answer"
              @input="other[item.id + ':' + index] = ($event.target as HTMLInputElement).value"
            >
          </fieldset>
          <div class="actions">
            <button
              v-if="item.kind === 'approval'"
              type="button"
              :disabled="!!busy"
              class="decision-primary"
              @click="answer(item, 'approved')"
            >
              Approve
            </button>
            <button
              v-if="item.kind === 'approval'"
              type="button"
              :disabled="!!busy"
              @click="answer(item, 'denied')"
            >
              Deny
            </button>
            <button
              v-if="item.kind === 'question'"
              type="button"
              :disabled="!!busy"
              class="decision-primary"
              @click="answer(item, 'answered')"
            >
              Send answer
            </button>
            <button
              type="button"
              :disabled="!!busy"
              @click="answer(item, 'deferred')"
            >
              Defer
            </button>
          </div>
          <small>Expires {{ new Date(item.expiresAt).toLocaleTimeString() }}. Deferring keeps the request waiting until then.</small>
        </template>
        <button
          type="button"
          @click="openConversation(item)"
        >
          Open original conversation
        </button>
      </article>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { useDecisions } from '@pkg/composables/useDecisions';
import { restoreChatFromHistory } from '@pkg/pages/chat/services/historyRestore';
import type { DecisionRecord, DecisionResponse } from '@pkg/shared/decisions';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
const { records, pending, error, refresh } = useDecisions();
const router = useRouter();
const settings = ref(false);
const search = ref('');
const busy = ref('');
const actionError = ref('');
interface Policy { name: string; category: string; description: string; required: boolean }
const policies = ref<Policy[]>([]);
const choices = ref<Record<string, string[]>>({});
const other = ref<Record<string, string>>({});
const filtered = computed(() => policies.value.filter(p => `${ p.category } ${ p.name } ${ p.description }`.toLowerCase().includes(search.value.toLowerCase())));
const categories = computed(() => [...new Set(filtered.value.map(p => p.category))].sort());
function selected(id: string, index: number) { return choices.value[id + ':' + index] || [] }
function select(id: string, index: number, label: string, multiple: boolean) {
  const previous = selected(id, index);
  choices.value[id + ':' + index] = multiple ? (previous.includes(label) ? previous.filter(v => v !== label) : [...previous, label]) : [label];
}
async function openSettings() {
  try { policies.value = await ipcRenderer.invoke('decisions:policies'); settings.value = true } catch { actionError.value = 'Could not load approval settings.' }
}
async function setPolicy(policy: Policy, required: boolean) {
  busy.value = policy.name;
  try { await ipcRenderer.invoke('decisions:set-policy', policy.name, required); policy.required = required; actionError.value = '' } catch { actionError.value = 'Policy was not saved. Refresh and try again.' } finally { busy.value = '' }
}
function openConversation(item: DecisionRecord) {
  const tab = restoreChatFromHistory({ id: item.conversationId, thread_id: item.conversationId, type: 'graph', title: item.title });
  router.push(`/Browser/${ tab.id }`).catch(() => { actionError.value = 'Could not open the original conversation.' });
}
async function answer(item: DecisionRecord, action: DecisionResponse['action']) {
  busy.value = item.id;
  try {
    const result = await ipcRenderer.invoke('decisions:resolve', {
      id:             item.id,
      conversationId: item.conversationId,
      action,
      answers:        item.questions?.map((q, i) => ({
        question: q.question,
        selected: other.value[item.id + ':' + i]?.trim() ? [other.value[item.id + ':' + i].trim()] : selected(item.id, i),
      })),
    });
    if (!result.settled) throw new Error(result.reason || 'Request was not accepted.');
    actionError.value = '';
    await refresh();
    if (action !== 'deferred') openConversation(item);
  } catch (e) { actionError.value = e instanceof Error ? e.message : 'Decision was not accepted.' } finally { busy.value = '' }
}
</script>
<style scoped>
.decide-page { height: 100%; overflow: auto; padding: 28px; background: var(--bg, #10151d); color: var(--text, #e5e7eb); }
header, .actions { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
header > div, header h2 { flex: 1; }
h1 { font-size: 28px; } h2 { font-size: 18px; } p, small { color: var(--text-muted, #a9b3c1); }
.decision { padding: 20px; margin: 18px 0; border: 1px solid var(--border, #35404d); border-radius: 12px; background: var(--surface-1, #18212d); }
button { padding: 9px 14px; border: 1px solid var(--accent, #5096b3); border-radius: 7px; margin: 6px 0; background: transparent; color: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: wait; }
input[type=search], input:not([type]) { padding: 10px; width: 100%; background: transparent; color: inherit; border: 1px solid var(--border, #35404d); }
.policy, .option { display: flex; gap: 12px; padding: 12px 0; align-items: start; }
small { display: block; margin: 5px 0; } fieldset { margin: 14px 0; padding: 12px; }
</style>

<style scoped>
:global(.theme-noir) .decide-page {
  padding: 42px clamp(28px, 5vw, 68px);
  background: radial-gradient(75% 50% at 50% 110%, color-mix(in srgb, var(--nx-accent) 833.3333%, transparent), transparent 65%), var(--nx-paper);
  color: var(--nx-read-2);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
:global(.theme-noir) .decide-page > * { max-width: 920px; margin-left: auto; margin-right: auto; }
:global(.theme-noir) .decide-hero { margin-bottom: 30px; }
:global(.theme-noir) .decide-eyebrow {
  display: block;
  margin-bottom: 7px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  font-size: 10.5px;
  letter-spacing: .14em;
  text-transform: uppercase;
  color: var(--nx-accent-2);
}
:global(.theme-noir) .decide-page h1 {
  margin: 0 0 6px;
  font-family: 'Playfair Display', Georgia, serif;
  font-size: 36px;
  font-weight: 600;
  letter-spacing: -.025em;
  color: var(--nx-read-1);
}
:global(.theme-noir) .decide-page h2 { font-family: 'Playfair Display', Georgia, serif; color: var(--nx-read-1); }
:global(.theme-noir) .decide-page p,
:global(.theme-noir) .decide-page small { color: var(--nx-read-4); }
:global(.theme-noir) .decision {
  position: relative;
  padding: 22px;
  margin: 14px auto;
  border: 0;
  border-radius: 18px;
  background: color-mix(in srgb, var(--nx-warning) 2222.2222%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-warning) 416.6667%, transparent), 0 18px 50px color-mix(in srgb, var(--shadow) 450%, transparent);
  transition: transform .58s linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1), box-shadow .2s;
  animation: decide-noir-enter .45s cubic-bezier(.22, 1, .36, 1) both;
}
:global(.theme-noir) .decision:hover { transform: translateY(-2px); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-warning) 294.1176%, transparent), 0 22px 58px color-mix(in srgb, var(--shadow) 300%, transparent); }
:global(.theme-noir) .decision-approved,
:global(.theme-noir) .decision-answered {
  background: color-mix(in srgb, var(--nx-success) 2222.2222%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-success) 400%, transparent), 0 18px 50px color-mix(in srgb, var(--shadow) 450%, transparent);
}
:global(.theme-noir) .decision header > span {
  padding: 4px 9px;
  border-radius: 999px;
  font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
  font-size: 10px;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--nx-warning);
  background: color-mix(in srgb, var(--nx-warning) 1000%, transparent);
}
:global(.theme-noir) .decision-approved header > span,
:global(.theme-noir) .decision-answered header > span { color: var(--nx-success); background: color-mix(in srgb, var(--nx-success) 1000%, transparent); }
:global(.theme-noir) .decide-page fieldset {
  border: 0;
  border-radius: 14px;
  background: color-mix(in srgb, var(--bg-surface-alt) 200%, transparent);
  box-shadow: inset 0 0 0 1px var(--nx-hair);
}
:global(.theme-noir) .decide-page input[type='search'],
:global(.theme-noir) .decide-page input:not([type]) {
  min-height: 42px;
  padding: 0 14px;
  border: 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--bg-surface-alt) 151.5152%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-hair-strong) 133.3333%, transparent);
}
:global(.theme-noir) .decide-page button {
  border-color: color-mix(in srgb, var(--nx-hair-strong) 114.2857%, transparent);
  border-radius: 999px;
  color: var(--nx-read-3);
  transition: transform .45s cubic-bezier(.22, 1, .36, 1), background .16s, color .16s;
}
:global(.theme-noir) .decide-page button:hover { transform: translateY(-1px); color: var(--nx-read-1); background: color-mix(in srgb, var(--nx-accent) 1111.1111%, transparent); }
:global(.theme-noir) .decide-page .decision-primary {
  border-color: color-mix(in srgb, var(--nx-accent-2) 222.2222%, transparent);
  color: var(--nx-paper);
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 20px color-mix(in srgb, var(--nx-accent) 416.6667%, transparent), inset 0 1px color-mix(in srgb, var(--text-on-accent) 500%, transparent);
}
@keyframes decide-noir-enter { from { opacity: 0; transform: translateY(8px); filter: blur(8px); } to { opacity: 1; transform: none; filter: none; } }
@media (prefers-reduced-motion: reduce) {
  :global(.theme-noir) .decision { animation: none; transition: none; }
  :global(.theme-noir) .decide-page button { transition: none; }
}
</style>
