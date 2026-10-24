<script setup lang="ts">
import { computed } from 'vue';

import PrefCard from '../PrefCard.vue';
import PrefChoice from '../PrefChoice.vue';
import PrefMore from '../PrefMore.vue';
import PrefRow from '../PrefRow.vue';
import PrefToggle from '../PrefToggle.vue';

import { MODEL_TIERS, useModelSettings, type ModelSlot } from '@pkg/composables/preferences/useModelSettings';
import { openMainTab } from '@pkg/composables/preferences/openInMain';
import { useSullaSetting } from '@pkg/composables/preferences/useSullaSetting';

const SLOTS: ModelSlot[] = ['primary', 'secondary', 'subconscious'];
const SLOT_LABELS: Record<ModelSlot, string> = { primary: 'Main model', secondary: 'Backup model', subconscious: 'Background model' };

const m = useModelSettings();
const fallbackEnabled = useSullaSetting('fallbackEnabled', true, 'boolean', { refreshOnFocus: true });
const retries = useSullaSetting('remoteRetryCount', 3, 'number');
const timeout = useSullaSetting('remoteTimeoutSeconds', 60, 'number');

const where = computed(() => m.runsLocally.value ? 'local' : 'online');
const whereOptions = computed(() => [
  {
    value:    'online',
    title:    'Online models',
    subtitle: 'Anthropic, OpenAI, Google, xAI and other providers, using your keys.',
    disabled: !m.onlineProvider.value && where.value !== 'online',
  },
  {
    value:    'local',
    title:    'On this Mac',
    subtitle: m.localProvider.value || m.runsLocally.value
      ? 'Local models through Ollama. Slower, fully private.'
      : 'Local models through Ollama. Connect Ollama in Integrations to use it.',
    disabled: !m.localProvider.value && !m.runsLocally.value,
  },
]);

function providerLabel(p: { name: string, connected: boolean }) {
  return p.connected ? p.name : `${ p.name } (not connected)`;
}

/** The model list for a select, keeping the saved value visible even if the provider didn't return it. */
function modelOptions(slot: ModelSlot, current: string) {
  const list = m.models[slot];

  if (current && !list.some(model => model.id === current) && !MODEL_TIERS.some(t => t.id === current)) {
    return [{ id: current, name: current }, ...list];
  }

  return list;
}

const multipleConnections = computed(() => SLOTS.some(slot => m.accounts[slot].length > 1));

function activeAccount(slot: ModelSlot) {
  return m.accounts[slot].find(a => a.active)?.accountId ?? '';
}

function saveNumber(setting: typeof retries, raw: string, min: number, max: number) {
  const n = Math.round(Number(raw));

  if (Number.isFinite(n) && n >= min && n <= max) {
    void setting.save(n);
  } else {
    void setting.reload();
  }
}

function value(event: Event) {
  return (event.target as HTMLSelectElement | HTMLInputElement).value;
}
</script>

<template>
  <div>
    <div class="ph">
      <div>
        <h1>AI models</h1>
        <p>Which models answer, which back them up, and which think in the background.</p>
      </div>
    </div>

    <PrefCard title="Where models run">
      <PrefRow layout="col">
        <PrefChoice
          :model-value="where"
          :options="whereOptions"
          :disabled="m.loading.value"
          @update:model-value="m.setWhere($event === 'local' ? 'local' : 'online')"
        />
      </PrefRow>
    </PrefCard>

    <PrefCard
      title="Models"
      subtitle="Keys for each provider live in Passwords."
    >
      <template #actions>
        <button
          type="button"
          class="link"
          @click="openMainTab('vault')"
        >
          Open Passwords
        </button>
      </template>
      <PrefRow
        title="Main model"
        subtitle="Answers your chats and runs your agents."
      >
        <select
          class="sel"
          aria-label="Main model provider"
          :value="m.state.primaryProvider"
          @change="m.setPrimaryProvider(value($event))"
        >
          <option
            v-for="p in m.providers.value"
            :key="p.id"
            :value="p.id"
          >
            {{ providerLabel(p) }}
          </option>
        </select>
        <select
          class="sel"
          aria-label="Main model"
          :value="m.state.activeModelId"
          @change="m.setPrimaryModel(value($event))"
        >
          <option
            v-if="!m.state.activeModelId"
            value=""
          >
            Provider default
          </option>
          <option
            v-for="model in modelOptions('primary', m.state.activeModelId)"
            :key="model.id"
            :value="model.id"
          >
            {{ model.name }}
          </option>
        </select>
      </PrefRow>
      <PrefRow
        title="Backup model"
        subtitle="Takes over when the main model fails or is busy."
      >
        <PrefToggle
          :model-value="fallbackEnabled.value.value"
          label="Use a backup model"
          @update:model-value="fallbackEnabled.save($event)"
        />
        <select
          class="sel"
          aria-label="Backup model provider"
          :value="m.state.secondaryProvider"
          :disabled="!fallbackEnabled.value.value"
          @change="m.setSecondaryProvider(value($event))"
        >
          <option
            v-for="p in m.providers.value"
            :key="p.id"
            :value="p.id"
          >
            {{ providerLabel(p) }}
          </option>
        </select>
        <select
          class="sel"
          aria-label="Backup model"
          :value="m.state.secondaryModelId"
          :disabled="!fallbackEnabled.value.value"
          @change="m.setSecondaryModel(value($event))"
        >
          <option value="">
            Provider default
          </option>
          <option
            v-for="tier in MODEL_TIERS"
            :key="tier.id"
            :value="tier.id"
          >
            {{ tier.name }}
          </option>
          <option
            v-for="model in modelOptions('secondary', m.state.secondaryModelId)"
            :key="model.id"
            :value="model.id"
          >
            {{ model.name }}
          </option>
        </select>
      </PrefRow>
      <PrefRow
        title="Background model"
        subtitle="Memory, summaries and other quiet work."
      >
        <select
          class="sel"
          aria-label="Background model provider"
          :value="m.state.subconsciousProvider"
          @change="m.setSubconsciousProvider(value($event))"
        >
          <option value="default">
            Same as main
          </option>
          <option
            v-for="p in m.providers.value"
            :key="p.id"
            :value="p.id"
          >
            {{ providerLabel(p) }}
          </option>
        </select>
        <select
          class="sel"
          aria-label="Background model"
          :value="m.state.subconsciousModelId"
          @change="m.setSubconsciousModel(value($event))"
        >
          <option value="">
            Provider default
          </option>
          <option
            v-for="tier in MODEL_TIERS"
            :key="tier.id"
            :value="tier.id"
          >
            {{ tier.name }}
          </option>
          <option
            v-for="model in modelOptions('subconscious', m.state.subconsciousModelId)"
            :key="model.id"
            :value="model.id"
          >
            {{ model.name }}
          </option>
        </select>
      </PrefRow>
      <PrefMore label="Connections">
        <PrefRow
          v-for="slot in SLOTS"
          :key="slot"
          :title="SLOT_LABELS[slot]"
          subtitle="Which saved connection this provider uses."
        >
          <select
            v-if="m.accounts[slot].length > 1"
            class="sel"
            :aria-label="`${ slot } connection`"
            :value="activeAccount(slot)"
            @change="m.setConnection(slot, value($event))"
          >
            <option
              v-for="acct in m.accounts[slot]"
              :key="acct.accountId"
              :value="acct.accountId"
            >
              {{ acct.label }}{{ acct.connected ? '' : ' (not connected)' }}
            </option>
          </select>
          <span
            v-else-if="m.accounts[slot].length === 1"
            class="dimc"
          >{{ m.accounts[slot][0].label }}{{ m.accounts[slot][0].connected ? '' : ' (not connected)' }}</span>
          <span
            v-else
            class="dimc"
          >No saved connection</span>
        </PrefRow>
        <PrefRow
          title="Provider list"
          :subtitle="multipleConnections ? 'Reload after adding a key in Passwords.' : 'Only connected providers are listed. Reload after adding a key in Passwords.'"
        >
          <button
            type="button"
            class="btn sm"
            @click="m.loadProviders()"
          >
            Refresh providers
          </button>
        </PrefRow>
      </PrefMore>
      <p
        v-if="m.error.value || fallbackEnabled.error.value"
        class="note badc"
      >
        {{ m.error.value || fallbackEnabled.error.value }}
      </p>
    </PrefCard>

    <PrefCard title="Requests">
      <PrefRow
        title="Retries"
        subtitle="How many times Sulla retries a failed request."
      >
        <input
          class="inp sm"
          type="number"
          min="0"
          max="10"
          aria-label="Retries"
          :value="retries.value.value"
          @change="saveNumber(retries, value($event), 0, 10)"
        >
      </PrefRow>
      <PrefRow
        title="Time limit"
        subtitle="Seconds before a request gives up."
      >
        <input
          class="inp sm"
          type="number"
          min="5"
          max="600"
          aria-label="Time limit in seconds"
          :value="timeout.value.value"
          @change="saveNumber(timeout, value($event), 5, 600)"
        > <span class="dimc">seconds</span>
      </PrefRow>
    </PrefCard>
  </div>
</template>
