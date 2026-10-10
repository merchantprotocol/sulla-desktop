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
          <span
            class="frm-radio-mark"
            aria-hidden="true"
          />
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

.frm-radio-mark { display: none; }

.theme-noir .frm-page {
  --frm-spring: linear(0,.0258,.09,.1763,.2732,.3724,.4683,.5573,.6376,.7082,.7689,.8202,.8628,.8976,.9256,.9476,.9648,.9778,.9875,.9945,.9994,1.0026,1.0047,1.0058,1.0062,1.0062,1.0059,1.0055,1.0049,1.0043,1.0036,1.0031,1.0025,1.002,1.0016,1.0013,1);
  background: transparent;
  color: var(--nx-read-2);
}

.theme-noir .frm-page form::before {
  content: "YOUR AI";
  display: block;
  margin-top: 5px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  font-weight: 500;
  letter-spacing: .14em;
  color: var(--nx-accent-2);
}

.theme-noir .frm-heading {
  margin: 7px 0 7px;
  font-family: "Playfair Display", Georgia, serif;
  font-size: 34px;
  line-height: 1.08;
  font-weight: 600;
  letter-spacing: -.02em;
  color: var(--nx-read-1);
}

.theme-noir .frm-subtext {
  margin-bottom: 22px;
  font-size: 14px;
  line-height: 1.6;
  color: var(--nx-read-3);
}

.theme-noir .frm-options { gap: 7px; }

.theme-noir .frm-option {
  min-height: 66px;
  gap: 13px;
  padding: 11px 14px;
  border-color: transparent;
  border-radius: 14px;
  background: rgb(from var(--nx-paper) calc(r + 2) calc(g + 3) calc(b + 2) / .4);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 7%, transparent);
  color: var(--nx-read-2);
  transition: transform .58s var(--frm-spring), background .2s ease, box-shadow .25s ease;
}

.theme-noir .frm-option:hover {
  transform: translateX(2px);
  border-color: transparent;
  background: color-mix(in srgb, var(--nx-accent) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 18%, transparent);
}

.theme-noir .frm-option.is-selected {
  border-color: transparent;
  background: color-mix(in srgb, var(--nx-accent) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--nx-accent-2) 42%, transparent), 0 0 20px color-mix(in srgb, var(--nx-accent) 10%, transparent);
}

.theme-noir .frm-radio-mark {
  display: grid;
  width: 17px;
  height: 17px;
  flex: none;
  place-items: center;
  border-radius: 50%;
  box-shadow: inset 0 0 0 1.5px var(--nx-read-5);
  transition: box-shadow .2s ease;
}

.theme-noir .frm-radio-mark::after {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--nx-accent-2);
  box-shadow: 0 0 8px var(--nx-accent-2);
  transform: scale(0);
  transition: transform .58s var(--frm-spring);
}

.theme-noir .frm-option.is-selected .frm-radio-mark {
  box-shadow: inset 0 0 0 1.5px var(--nx-accent-2);
}

.theme-noir .frm-option.is-selected .frm-radio-mark::after { transform: scale(1); }

.theme-noir .frm-option-icon {
  width: 26px;
  height: 26px;
  filter: saturate(.75) drop-shadow(0 0 10px color-mix(in srgb, var(--nx-accent-2) 18%, transparent));
}

.theme-noir .frm-option-name {
  color: var(--nx-read-1);
  font-size: 13.5px;
  font-weight: 600;
}

.theme-noir .frm-option-plan {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace;
  font-size: 10.5px;
  color: var(--nx-read-4);
}

.theme-noir .frm-error-box {
  border-color: color-mix(in srgb, var(--nx-danger) 30%, transparent);
  border-radius: 12px;
  background: color-mix(in srgb, var(--nx-danger) 7%, transparent);
  color: rgb(from var(--nx-danger) calc(r - 4) calc(g + 82) calc(b + 86));
}

.theme-noir .frm-btn-accent {
  min-height: 40px;
  padding-inline: 20px;
  border-radius: 20px;
  color: #fff;
  background: linear-gradient(180deg, var(--nx-accent-2), var(--nx-accent));
  box-shadow: 0 0 18px color-mix(in srgb, var(--nx-accent) 34%, transparent);
  transition: transform .58s var(--frm-spring), box-shadow .2s ease;
}

.theme-noir .frm-btn-accent:hover:not(:disabled) {
  background: linear-gradient(180deg, rgb(from var(--nx-accent-2) calc(r + 8) calc(g + 10) calc(b + 9)), var(--nx-accent));
  box-shadow: 0 0 24px color-mix(in srgb, var(--nx-accent) 48%, transparent);
}

.theme-noir .frm-btn-accent:active { transform: scale(.95); }

.theme-noir .frm-btn-back {
  min-height: 40px;
  padding-inline: 18px;
  border-radius: 20px;
  color: var(--nx-read-3);
  background: transparent;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, rgb(from var(--nx-accent-2) calc(r + 62) calc(g + 16) calc(b + 16)) 12%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .theme-noir .frm-option,
  .theme-noir .frm-radio-mark::after,
  .theme-noir .frm-btn-accent {
    transition-duration: .01ms;
  }
}
</style>
