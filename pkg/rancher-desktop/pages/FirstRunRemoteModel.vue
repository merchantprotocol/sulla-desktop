<template>
  <div class="max-w-lg mx-0 p-6 frm-page">
    <form @submit.prevent="handleNext">
      <h2 class="text-2xl font-bold mt-5 mb-4 frm-heading">
        Choose the AI Sulla thinks with
      </h2>
      <p class="mb-6 frm-subtext">
        Sulla runs on a subscription you already have. You'll sign in with that account once your workspace finishes setting up. No API keys, and you can switch any time in Settings.
      </p>

      <div
        class="frm-options mb-6"
        role="radiogroup"
        aria-label="AI provider"
      >
        <button
          v-for="p in providers"
          :key="p.id"
          type="button"
          role="radio"
          :aria-checked="selected === p.id"
          class="frm-option"
          :class="{ 'is-selected': selected === p.id }"
          @click="select(p.id)"
        >
          <img
            v-if="firstRunAiIconSrc(p.icon)"
            :src="firstRunAiIconSrc(p.icon)!"
            alt=""
            class="frm-option-icon"
          >
          <span class="frm-option-text">
            <span class="frm-option-name">Sign in with {{ p.name }}</span>
            <span class="frm-option-plan">Uses your {{ p.plan }} plan</span>
          </span>
        </button>
      </div>

      <div
        v-if="error"
        class="mb-4 p-3 border rounded-md frm-error-box"
      >
        {{ error }}
      </div>

      <div class="flex justify-between mt-5">
        <button
          type="button"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 cursor-pointer frm-btn-back"
          @click="$emit('back')"
        >
          Back
        </button>
        <button
          type="submit"
          class="px-6 py-2 rounded-md transition-colors font-medium hover:opacity-90 frm-btn-accent"
        >
          Continue
        </button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';

import {
  FIRST_RUN_AI_PROVIDERS, FIRST_RUN_AI_PROVIDER_KEY, firstRunAiIconSrc, getFirstRunAiProvider, type FirstRunAiProviderId,
} from './firstRunAiProviders';

import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';

const emit = defineEmits<{
  next: [];
  back: [];
}>();

const providers = FIRST_RUN_AI_PROVIDERS;
const selected = ref<FirstRunAiProviderId | ''>('');
const error = ref<string | null>(null);

const select = (id: FirstRunAiProviderId) => {
  selected.value = id;
  error.value = null;
};

const handleNext = async() => {
  // Sulla has no local model fallback, so a provider is required to continue.
  if (!selected.value) {
    error.value = 'Choose an AI provider to continue.';

    return;
  }
  try {
    await SullaSettingsModel.set(FIRST_RUN_AI_PROVIDER_KEY, selected.value, 'string');
  } catch (err) {
    console.error('[FirstRun] Failed to save AI provider choice:', err);
    error.value = `Failed to save: ${ err instanceof Error ? err.message : String(err) }`;

    return;
  }
  emit('next');
};

onMounted(async() => {
  try {
    const saved = await SullaSettingsModel.get(FIRST_RUN_AI_PROVIDER_KEY, '');

    if (getFirstRunAiProvider(saved)) selected.value = saved as FirstRunAiProviderId;
  } catch {
    // No saved choice — fine
  }
});
</script>

<style lang="scss" scoped>
.frm-page {
  background-color: var(--bg-surface);
}

.frm-heading {
  color: var(--text-primary);
}

.frm-subtext {
  color: var(--text-secondary);
}

.frm-options {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.frm-option {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 14px 16px;
  text-align: left;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background-color: var(--bg-input);
  color: var(--text-primary);
  cursor: pointer;

  &:hover {
    border-color: var(--border-strong);
    background-color: var(--bg-surface-alt);
  }

  &.is-selected {
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 1px var(--accent-primary);
  }
}

.frm-option-icon {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
}

.frm-option-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.frm-option-name {
  font-weight: 600;
}

.frm-option-plan {
  font-size: 13px;
  color: var(--text-muted);
}

.frm-error-box {
  background-color: var(--bg-error);
  border-color: var(--border-error);
  color: var(--text-error);
}

.frm-btn-accent {
  background-color: var(--accent-primary);
  color: var(--text-on-accent);

  &:hover:not(:disabled) {
    background-color: var(--accent-primary-hover);
  }
}

.frm-btn-back {
  background-color: var(--bg-surface-hover);
  color: var(--text-secondary);

  &:hover {
    filter: brightness(1.1);
  }
}

button:hover {
  cursor: pointer;
}
</style>
