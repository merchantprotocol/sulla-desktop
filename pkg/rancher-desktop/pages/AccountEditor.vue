<template>
  <div class="text-sm font-sans h-full flex flex-col bg-slate-950 text-slate-100">
    <!-- Top bar: back + integration name -->
    <div class="flex items-center gap-3 px-4 py-3 border-b border-slate-700/50">
      <button
        type="button"
        class="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors"
        @click="$emit('back')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-3.5 w-3.5">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Back
      </button>
      <div class="h-4 w-px bg-slate-700" />
      <div class="flex items-center gap-2">
        <div
          v-if="integration && integrationIcon"
          class="h-5 w-5 rounded overflow-hidden"
        >
          <img
            :src="integrationIcon"
            :alt="integration.name"
            class="h-full w-full object-contain"
          >
        </div>
        <span class="font-medium text-sm">
          {{ isEditing ? 'Edit Account' : 'New Account' }}
          <span
            v-if="integration"
            class="text-slate-400"
          > &mdash; {{ integration.name }}</span>
        </span>
      </div>
    </div>

    <!-- Form content -->
    <div class="flex-1 overflow-auto">
      <div class="mx-auto max-w-xl px-4 py-6 space-y-6">
        <!-- Loading state -->
        <div
          v-if="loading"
          class="text-center py-12 text-slate-400"
        >
          Loading...
        </div>

        <template v-else-if="integration">
          <!-- OAuth section -->
          <div
            v-if="(integration.authType === 'oauth' || integration.oauth) && !isEditing"
            class="space-y-3"
          >
            <button
              type="button"
              class="w-full py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium transition-colors"
              :disabled="saving"
              @click="handleOAuthConnect"
            >
              Sign in with {{ integration.name }}
            </button>
            <p
              v-if="oauthError"
              class="text-xs text-red-400 text-center"
            >
              {{ oauthError }}
            </p>
            <div
              v-if="integration.properties && integration.properties.length > 0"
              class="flex items-center gap-3 text-xs text-slate-500"
            >
              <div class="flex-1 h-px bg-slate-700" />
              <span>or connect with credentials</span>
              <div class="flex-1 h-px bg-slate-700" />
            </div>
          </div>

          <!-- Account label (new accounts only) -->
          <div
            v-if="!isEditing"
            class="space-y-1.5"
          >
            <label class="block text-xs font-medium text-slate-300">
              Account Label <span class="text-red-400">*</span>
            </label>
            <input
              v-model="accountLabel"
              type="text"
              placeholder="e.g. Work Account, Personal"
              class="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
              :class="{ 'border-red-500': errors.__account_label }"
            >
            <p
              v-if="errors.__account_label"
              class="text-xs text-red-400"
            >
              {{ errors.__account_label }}
            </p>
          </div>

          <!-- Property fields -->
          <div
            v-for="property in visibleProperties"
            :key="property.key"
            class="space-y-1.5"
          >
            <label
              :for="'field-' + property.key"
              class="block text-xs font-medium text-slate-300"
            >
              {{ property.title }}
              <span
                v-if="property.required"
                class="text-red-400"
              >*</span>
            </label>

            <!-- Select field -->
            <div
              v-if="property.type === 'select'"
              class="flex gap-2"
            >
              <select
                :id="'field-' + property.key"
                v-model="formData[property.key]"
                class="flex-1 rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
                :class="{ 'border-red-500': errors[property.key] }"
                :disabled="selectOptionsLoading[property.key]"
              >
                <option
                  value=""
                  disabled
                >
                  {{ selectOptionsLoading[property.key] ? 'Loading...' : (property.placeholder || 'Select...') }}
                </option>
                <option
                  v-for="opt in selectOptions[property.key]"
                  :key="opt.value"
                  :value="opt.value"
                >
                  {{ opt.label }}{{ opt.description ? ` — ${opt.description}` : '' }}
                </option>
              </select>
              <button
                type="button"
                class="px-2 py-2 rounded-lg border border-slate-600 text-slate-400 hover:text-slate-200 hover:border-slate-500 transition-colors"
                title="Refresh options"
                @click="fetchSelectOptions(property)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                  <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                  <path d="M16 16h5v5" />
                </svg>
              </button>
            </div>

            <!-- Password field with eye toggle -->
            <div
              v-else-if="property.type === 'password'"
              class="relative"
            >
              <input
                :id="'field-' + property.key"
                v-model="formData[property.key]"
                :type="passwordVisible[property.key] ? 'text' : 'password'"
                :placeholder="property.placeholder"
                class="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 pr-10 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
                :class="{ 'border-red-500': errors[property.key] }"
                @blur="onDependencyFieldBlur(property.key)"
              >
              <button
                type="button"
                class="absolute inset-y-0 right-0 flex items-center pr-3 text-slate-500 hover:text-slate-300"
                @click="passwordVisible[property.key] = !passwordVisible[property.key]"
              >
                <svg
                  v-if="!passwordVisible[property.key]"
                  xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                >
                  <path d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
                <svg
                  v-else
                  xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2"
                >
                  <path d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
              </button>
            </div>

            <!-- Standard input -->
            <input
              v-else
              :id="'field-' + property.key"
              v-model="formData[property.key]"
              :type="property.type"
              :placeholder="property.placeholder"
              class="w-full rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 outline-none"
              :class="{ 'border-red-500': errors[property.key] }"
              @blur="onDependencyFieldBlur(property.key)"
            >

            <p
              v-if="property.hint"
              class="text-xs text-slate-500"
            >
              {{ property.hint }}
            </p>
            <p
              v-if="errors[property.key]"
              class="text-xs text-red-400"
            >
              {{ errors[property.key] }}
            </p>
          </div>

          <!-- Action buttons -->
          <div class="flex items-center gap-3 pt-2">
            <button
              type="button"
              class="flex-1 py-2.5 px-4 rounded-lg bg-sky-600 hover:bg-sky-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
              :disabled="saving"
              @click="handleSave"
            >
              {{ saving ? 'Saving...' : (isEditing ? 'Save Changes' : 'Connect') }}
            </button>
            <button
              type="button"
              class="py-2.5 px-4 rounded-lg border border-slate-600 text-slate-300 hover:text-white hover:border-slate-500 text-sm transition-colors"
              @click="$emit('back')"
            >
              Cancel
            </button>
          </div>

          <!-- Danger zone (edit mode only) -->
          <div
            v-if="isEditing"
            class="pt-4 border-t border-slate-800"
          >
            <button
              type="button"
              class="text-xs text-red-400 hover:text-red-300 transition-colors"
              @click="handleDelete"
            >
              Disconnect &amp; delete this account
            </button>
          </div>

          <!-- Installation guide (collapsible) -->
          <details
            v-if="integration.installationGuide"
            class="pt-4 border-t border-slate-800"
          >
            <summary class="text-xs font-medium text-slate-400 cursor-pointer hover:text-slate-300">
              Setup Guide
            </summary>
            <div class="mt-3 space-y-3">
              <p
                v-if="integration.installationGuide.description"
                class="text-xs text-slate-500"
              >
                {{ integration.installationGuide.description }}
              </p>
              <div
                v-for="(step, i) in integration.installationGuide.steps"
                :key="i"
                class="flex gap-3"
              >
                <div class="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-slate-800 text-xs font-bold text-slate-400">
                  {{ i + 1 }}
                </div>
                <div>
                  <p class="text-xs font-medium text-slate-300">
                    {{ step.title }}
                  </p>
                  <pre class="text-xs text-slate-500 whitespace-pre-wrap mt-1">{{ step.content }}</pre>
                </div>
              </div>
            </div>
          </details>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import { getIntegrationService } from '@pkg/agent/services/IntegrationService';
import { getExtensionService } from '@pkg/agent/services/ExtensionService';
import { integrations as baseCatalog } from '@pkg/agent/integrations/catalog';
import type { Integration } from '@pkg/agent/integrations/types';

const props = defineProps<{
  integrationId: string;
  accountId?: string;
  embedded?: boolean;
}>();

const emit = defineEmits<{
  back: [];
  saved: [accountId: string];
  deleted: [];
}>();

const integrationService = getIntegrationService();
const integration = ref<Integration | null>(null);
const loading = ref(true);
const saving = ref(false);

const isEditing = computed(() => !!props.accountId);

// Form state
const accountLabel = ref('');
const formData = ref<Record<string, string>>({});
const errors = ref<Record<string, string>>({});
const passwordVisible = ref<Record<string, boolean>>({});
const oauthError = ref('');

// Select state
const selectOptions = ref<Record<string, { value: string; label: string; description?: string }[]>>({});
const selectOptionsLoading = ref<Record<string, boolean>>({});

// Filter out llm_access from visible properties — show it but skip system fields
const visibleProperties = computed(() => {
  if (!integration.value?.properties) return [];
  return integration.value.properties;
});

// Icon resolution
const integrationIcon = computed(() => {
  if (!integration.value?.icon) return null;
  try {
    return require(`@pkg/assets/images/${ integration.value.icon }`);
  } catch {
    return null;
  }
});

// ── Data loading ──

async function loadIntegration() {
  loading.value = true;
  try {
    await integrationService.initialize();

    // Merge base + extension integrations
    const extensionService = getExtensionService();
    await extensionService.initialize();
    const catalog: Record<string, Integration> = { ...baseCatalog };
    for (const ext of extensionService.getExtensionIntegrations()) {
      catalog[ext.id] = ext;
    }

    integration.value = catalog[props.integrationId] || null;

    // Inject llm_access if not present
    if (integration.value?.properties) {
      const hasLlmAccess = integration.value.properties.some(p => p.key === 'llm_access');
      if (!hasLlmAccess) {
        integration.value = {
          ...integration.value,
          properties: [
            ...integration.value.properties,
            {
              key: 'llm_access', title: 'AI Access Level',
              hint: 'Controls what the AI agent can see and do with this credential',
              type: 'select' as const, required: false, placeholder: 'autofill',
              selectBoxId: 'vault_llm_access',
            },
          ],
        };
      }
    }

    // Load existing data if editing
    if (props.accountId && integration.value) {
      const formValues = await integrationService.getFormValues(props.integrationId, props.accountId);
      const data: Record<string, string> = {};
      for (const fv of formValues) {
        data[fv.property] = fv.value;
      }
      formData.value = data;

      const label = await integrationService.getAccountLabel(props.integrationId, props.accountId);
      accountLabel.value = label;
    }

    fetchAllSelectOptions();
  } catch (err) {
    console.error('[AccountEditor] Failed to load:', err);
  } finally {
    loading.value = false;
  }
}

// ── Select box helpers ──

async function fetchSelectOptions(property: { key: string; selectBoxId?: string; selectDependsOn?: string[] }) {
  if (!integration.value || !property.selectBoxId) return;
  selectOptionsLoading.value[property.key] = true;
  try {
    const depValues: Record<string, string> = {};
    for (const depKey of (property.selectDependsOn ?? [])) {
      if (formData.value[depKey]) depValues[depKey] = formData.value[depKey];
    }
    const options = await integrationService.getSelectOptions(
      property.selectBoxId, props.integrationId, props.accountId || 'default', depValues,
    );
    selectOptions.value[property.key] = options;
  } catch {
    selectOptions.value[property.key] = [];
  } finally {
    selectOptionsLoading.value[property.key] = false;
  }
}

function fetchAllSelectOptions() {
  if (!integration.value?.properties) return;
  for (const prop of integration.value.properties) {
    if (prop.type === 'select' && prop.selectBoxId) fetchSelectOptions(prop);
  }
}

function onDependencyFieldBlur(changedKey: string) {
  if (!integration.value?.properties) return;
  for (const prop of integration.value.properties) {
    if (prop.type === 'select' && prop.selectDependsOn?.includes(changedKey)) {
      fetchSelectOptions(prop);
    }
  }
}

// ── Validation ──

function validateForm(): boolean {
  errors.value = {};
  let valid = true;

  if (!isEditing.value) {
    if (!accountLabel.value.trim()) {
      errors.value.__account_label = 'Account label is required';
      valid = false;
    }
  }

  if (integration.value?.properties) {
    for (const prop of integration.value.properties) {
      const val = formData.value[prop.key] || '';
      if (prop.required && !val.trim()) {
        errors.value[prop.key] = `${ prop.title } is required`;
        valid = false;
      }
      if (val && prop.validation) {
        if (prop.validation.pattern && !new RegExp(prop.validation.pattern).test(val)) {
          errors.value[prop.key] = `${ prop.title } format is invalid`;
          valid = false;
        }
        if (prop.validation.minLength && val.length < prop.validation.minLength) {
          errors.value[prop.key] = `${ prop.title } must be at least ${ prop.validation.minLength } characters`;
          valid = false;
        }
        if (prop.validation.maxLength && val.length > prop.validation.maxLength) {
          errors.value[prop.key] = `${ prop.title } must be no more than ${ prop.validation.maxLength } characters`;
          valid = false;
        }
      }
    }
  }

  return valid;
}

// ── Save ──

async function handleSave() {
  if (!integration.value || !validateForm()) return;
  saving.value = true;

  try {
    const targetAccountId = isEditing.value
      ? props.accountId!
      : accountLabel.value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');

    if (!isEditing.value) {
      await integrationService.setAccountLabel(props.integrationId, targetAccountId, accountLabel.value.trim());
    }

    const inputs = Object.entries(formData.value).map(([key, value]) => ({
      integration_id: props.integrationId,
      account_id:     targetAccountId,
      property:       key,
      value,
    }));
    await integrationService.setFormValues(inputs);

    if (!isEditing.value) {
      await integrationService.setConnectionStatus(props.integrationId, true, targetAccountId);
      // Set as active if first account
      const accounts = await integrationService.getAccounts(props.integrationId);
      if (accounts.length <= 1) {
        await integrationService.setActiveAccount(props.integrationId, targetAccountId);
      }
    }

    emit('saved', targetAccountId);
  } catch (err) {
    console.error('[AccountEditor] Save failed:', err);
  } finally {
    saving.value = false;
  }
}

// ── OAuth ──

async function handleOAuthConnect() {
  if (!integration.value) return;
  oauthError.value = '';
  saving.value = true;

  try {
    const targetAccountId = 'oauth';
    let clientId = '';
    let clientSecret = '';

    if (integration.value.authType === 'oauth') {
      clientId = formData.value['client_id'] || '';
      clientSecret = formData.value['client_secret'] || '';
      if (!clientId || !clientSecret) {
        oauthError.value = 'Client ID and Client Secret are required.';
        saving.value = false;
        return;
      }
    }

    await integrationService.setAccountLabel(props.integrationId, targetAccountId, integration.value.name + ' OAuth');
    await integrationService.startOAuthFlow(
      props.integrationId, integration.value.oauthProviderId!, clientId, clientSecret, targetAccountId,
    );
    await integrationService.setActiveAccount(props.integrationId, targetAccountId);
    emit('saved', targetAccountId);
  } catch (err: any) {
    oauthError.value = err?.message || 'OAuth failed. Please try again.';
  } finally {
    saving.value = false;
  }
}

// ── Delete ──

async function handleDelete() {
  if (!integration.value || !props.accountId) return;
  saving.value = true;
  try {
    if (integration.value.authType === 'oauth' || integration.value.oauth) {
      try { await integrationService.revokeOAuthTokens(props.integrationId, props.accountId); } catch { /* ok */ }
    }
    await integrationService.deleteAccount(props.integrationId, props.accountId);
    emit('deleted');
  } catch (err) {
    console.error('[AccountEditor] Delete failed:', err);
  } finally {
    saving.value = false;
  }
}

// ── Lifecycle ──

onMounted(() => loadIntegration());

watch(() => [props.integrationId, props.accountId], () => {
  formData.value = {};
  errors.value = {};
  accountLabel.value = '';
  loadIntegration();
});
</script>
