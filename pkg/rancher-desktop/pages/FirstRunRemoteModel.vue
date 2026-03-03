<template>
  <div class="max-w-lg mx-0 p-6 bg-white dark:bg-gray-800/30">
    <form @submit.prevent="handleNext">
      <h2 class="text-2xl font-bold mt-5 mb-4 text-gray-900 dark:text-gray-100">Remote Model (Optional)</h2>
      <p class="mb-6 text-gray-600 dark:text-gray-400">
        Optionally enable a remote model. While your system will be fully configured to run a local model, at times that can be very slow, and many people prefer to run a remote model for better performance. You can toggle between local and remote models at any time.
      </p>

      <rd-fieldset legend-text="Remote Model Configuration" class="mb-6 dark:text-gray-100">
        <!-- Error display -->
        <div v-if="error" class="mb-4 p-3 bg-red-100 border border-red-400 text-red-700 rounded-md">
          {{ error }}
        </div>

        <!-- Provider selector -->
        <div class="mb-4">
          <label for="provider" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Provider:</label>
          <select
            id="provider"
            v-model="selectedProviderId"
            @change="onProviderChange"
            class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
          >
            <option value="">Select a provider...</option>
            <option v-for="p in aiProviders" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>

        <!-- Dynamic property fields for selected provider -->
        <template v-if="selectedIntegration && selectedIntegration.properties">
          <div v-for="property in selectedIntegration.properties" :key="property.key" class="mb-4">
            <label :for="property.key" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {{ property.title }}
              <span v-if="property.required" class="text-red-500">*</span>
            </label>

            <!-- Select field (e.g. model select boxes) -->
            <div v-if="property.type === 'select'" class="flex gap-2">
              <select
                :id="property.key"
                v-model="formData[property.key]"
                :disabled="selectOptionsLoading[property.key]"
                class="flex-1 p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 disabled:opacity-50"
                :class="{ 'border-red-500': !!errors[property.key] }"
              >
                <option value="" disabled>
                  {{ selectOptionsLoading[property.key] ? 'Loading...' : (property.placeholder || 'Select...') }}
                </option>
                <option
                  v-for="opt in (selectOptions[property.key] || [])"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}{{ opt.description ? ` — ${opt.description}` : '' }}
                </option>
              </select>
              <button
                type="button"
                @click="fetchSelectOptionsForProperty(property)"
                :disabled="selectOptionsLoading[property.key]"
                class="px-3 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed"
                title="Refresh options"
              >
                <svg class="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              </button>
            </div>

            <!-- Standard input (password, text, url) -->
            <input
              v-else
              :id="property.key"
              :type="property.type"
              v-model="formData[property.key]"
              :placeholder="property.placeholder"
              :required="property.required"
              class="w-full p-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              :class="{ 'border-red-500': !!errors[property.key] }"
              @blur="onFieldBlur(property.key)"
            >

            <p v-if="property.hint" class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ property.hint }}</p>
            <p v-if="errors[property.key]" class="mt-1 text-xs text-red-600">{{ errors[property.key] }}</p>
          </div>
        </template>

        <!-- Test credentials -->
        <div v-if="selectedProviderId" class="flex gap-2 items-center">
          <button type="button" @click="testCredentials" :disabled="testing" class="px-4 py-2 bg-gray-500 text-white rounded-md hover:bg-gray-600 disabled:opacity-50">
            {{ testing ? 'Testing...' : 'Test Credentials' }}
          </button>
          <span v-if="testResult" class="text-sm" :class="testResult.success ? 'text-green-600' : 'text-red-600'">{{ testResult.message }}</span>
        </div>
      </rd-fieldset>

      <div class="flex justify-between mt-5">
        <button type="button" @click="$emit('back')" class="px-6 py-2 text-gray-500 rounded-md transition-colors font-medium hover:opacity-90 bg-gray-100 hover:bg-gray-200 cursor-pointer">Back</button>
        <button type="submit" class="px-6 py-2 text-white rounded-md transition-colors font-medium hover:opacity-90" :style="{ backgroundColor: '#30a5e9' }">Next</button>
      </div>
    </form>
  </div>
</template>

<script setup lang="ts">
import { ref, inject, onMounted, computed } from 'vue';
import type { Ref } from 'vue';
import type { RecursivePartial } from '@pkg/utils/typeUtils';
import type { Settings } from '@pkg/config/settings';
import RdFieldset from '@pkg/components/form/RdFieldset.vue';
import { integrations, type Integration } from '@pkg/agent/integrations/catalog';
import { SullaSettingsModel } from '@pkg/agent/database/models/SullaSettingsModel';
import { getSelectBoxProvider } from '@pkg/agent/integrations/select_box/registry';

const settings = inject<Ref<Settings>>('settings')!;
const commitChanges = inject<(settings: RecursivePartial<Settings>) => Promise<void>>('commitChanges')!;
const emit = defineEmits<{
  next: [];
  back: [];
}>();

// IDs that are AI providers but not remote LLM providers
const EXCLUDED_IDS = ['activepieces', 'ollama'];

// Filter the catalog to only AI Infrastructure integrations suitable for remote LLM
const aiProviders = computed<Integration[]>(() => {
  return Object.values(integrations)
    .filter(i => i.category === 'AI Infrastructure' && !EXCLUDED_IDS.includes(i.id))
    .sort((a, b) => a.sort - b.sort);
});

const selectedProviderId = ref('');
const formData = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const error = ref<string | null>(null);
const testing = ref(false);
const testResult = ref<{ success: boolean; message: string } | null>(null);

// Select box state
const selectOptions = ref<Record<string, Array<{ value: string; label: string; description?: string }>>>({});
const selectOptionsLoading = ref<Record<string, boolean>>({});

const selectedIntegration = computed<Integration | null>(() => {
  if (!selectedProviderId.value) return null;
  return integrations[selectedProviderId.value] || null;
});

// When provider changes, reset form and load any previously saved first-run values
const onProviderChange = async () => {
  formData.value = {};
  errors.value = {};
  testResult.value = null;
  selectOptions.value = {};

  if (!selectedProviderId.value) return;

  // Load any previously saved first-run form values from SullaSettingsModel
  const props = selectedIntegration.value?.properties;
  if (props) {
    for (const prop of props) {
      const saved = await SullaSettingsModel.get(`firstrun_${selectedProviderId.value}_${prop.key}`, '');
      if (saved) {
        formData.value[prop.key] = saved;
      }
    }
  }

  // Fetch select box options for properties that have deps already satisfied
  fetchAllSelectOptions();
};

// When a non-select field loses focus, refresh any select fields that depend on it
const onFieldBlur = (changedKey: string) => {
  const props = selectedIntegration.value?.properties;
  if (!props) return;

  for (const prop of props) {
    if (prop.type === 'select' && prop.selectDependsOn?.includes(changedKey)) {
      fetchSelectOptionsForProperty(prop);
    }
  }
};

// Fetch options for a single select property using the SelectBoxProvider directly (no DB needed)
const fetchSelectOptionsForProperty = async (property: { key: string; selectBoxId?: string; selectDependsOn?: string[] }) => {
  if (!selectedProviderId.value || !property.selectBoxId) return;

  selectOptionsLoading.value[property.key] = true;
  try {
    const depValues: Record<string, string> = {};
    for (const depKey of (property.selectDependsOn ?? [])) {
      if (formData.value[depKey]) {
        depValues[depKey] = formData.value[depKey];
      }
    }

    // Call the select box provider directly — no IntegrationService/DB required
    const provider = getSelectBoxProvider(property.selectBoxId);
    if (provider) {
      const options = await provider.getOptions({
        integrationId: selectedProviderId.value,
        accountId: 'default',
        formValues: depValues,
      });
      selectOptions.value[property.key] = options;
    } else {
      selectOptions.value[property.key] = [];
    }
  } catch (err) {
    console.error(`[FirstRun] Failed to fetch select options for ${property.key}:`, err);
    selectOptions.value[property.key] = [];
  } finally {
    selectOptionsLoading.value[property.key] = false;
  }
};

// Fetch select options for all select properties
const fetchAllSelectOptions = () => {
  const props = selectedIntegration.value?.properties;
  if (!props) return;

  for (const prop of props) {
    if (prop.type === 'select' && prop.selectBoxId) {
      fetchSelectOptionsForProperty(prop);
    }
  }
};

// Validate that required fields are filled
const validateForm = (): boolean => {
  const props = selectedIntegration.value?.properties;
  if (!props) return true;

  errors.value = {};
  let valid = true;

  for (const prop of props) {
    if (prop.required && (!formData.value[prop.key] || !formData.value[prop.key].trim())) {
      errors.value[prop.key] = `${prop.title} is required`;
      valid = false;
    }
  }

  return valid;
};

const testCredentials = async () => {
  if (!selectedProviderId.value) return;
  if (!validateForm()) return;

  testing.value = true;
  testResult.value = null;

  try {
    // Find the model select property and try to fetch its options as a credential test
    const modelProp = selectedIntegration.value?.properties?.find(p => p.key === 'model' && p.type === 'select');
    if (modelProp) {
      await fetchSelectOptionsForProperty(modelProp);
      const opts = selectOptions.value[modelProp.key] || [];
      if (opts.length > 0) {
        testResult.value = { success: true, message: `Credentials valid! Found ${opts.length} models.` };
      } else {
        testResult.value = { success: false, message: 'Connected but no models returned.' };
      }
    } else {
      // No model select — just report form is valid
      testResult.value = { success: true, message: 'Configuration looks good.' };
    }
  } catch {
    testResult.value = { success: false, message: 'Test failed. Check your credentials and try again.' };
  } finally {
    testing.value = false;
  }
};

const handleNext = async () => {
  // If a provider is selected and has values filled, save to SullaSettingsModel
  // (no database/IntegrationService available during first run)
  if (selectedProviderId.value && selectedIntegration.value?.properties) {
    const hasValues = Object.values(formData.value).some(v => v && v.trim());

    if (hasValues) {
      if (!validateForm()) return;

      try {
        const providerId = selectedProviderId.value;

        // Save each form field to SullaSettingsModel with a prefixed key
        // The seeder will pick these up and migrate them into IntegrationService
        for (const [key, value] of Object.entries(formData.value)) {
          if (value && value.trim()) {
            await SullaSettingsModel.set(`firstrun_${providerId}_${key}`, value, 'string');
          }
        }

        // Save which provider was configured during first run
        await SullaSettingsModel.set('firstrun_remoteProvider', providerId, 'string');

        // Set this as the primary provider
        await SullaSettingsModel.set('primaryProvider', providerId, 'string');

        // Also save legacy settings for backward compatibility
        await SullaSettingsModel.set('remoteProvider', providerId, 'string');
        if (formData.value.api_key) {
          await SullaSettingsModel.set('remoteApiKey', formData.value.api_key, 'string');
        }
        if (formData.value.model) {
          await SullaSettingsModel.set('remoteModel', formData.value.model, 'string');
        }

        // Save modelMode so the system knows to use remote
        await commitChanges({
          experimental: {
            remoteProvider: providerId,
            modelMode: 'remote',
          },
        });
      } catch (err) {
        console.error('[FirstRun] Failed to save credentials:', err);
        error.value = `Failed to save: ${err instanceof Error ? err.message : String(err)}`;
        return;
      }
    }
  }

  emit('next');
};

onMounted(async () => {
  // Ensure the select box providers are registered
  try {
    await import('@pkg/agent/integrations/select_box');
  } catch {
    // Non-fatal — select boxes just won't work
  }

  // Check if a provider was previously configured during this first-run session
  try {
    const savedProvider = await SullaSettingsModel.get('firstrun_remoteProvider', '');
    if (savedProvider && integrations[savedProvider]) {
      selectedProviderId.value = savedProvider;
      await onProviderChange();
    }
  } catch {
    // No saved state — fine
  }
});
</script>

<style lang="scss" scoped>
/* Hover effects */
button:hover {
  cursor: pointer;
}

input:hover, select:hover {
  border-color: #374151; /* darker gray border */
  background-color: #f3f4f6; /* slightly darker background */
}

.dark input:hover, .dark select:hover {
  background-color: #4b5563 !important; /* darker background for dark mode */
}
</style>
