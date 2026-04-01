<template>
  <div class="account-editor">
    <!-- Header bar -->
    <div class="editor-header">
      <button
        type="button"
        class="editor-back-btn"
        @click="$emit('back')"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" class="h-4 w-4">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        Back to Vault
      </button>
    </div>

    <!-- Scrollable content -->
    <div class="editor-scroll">
      <!-- Loading -->
      <div
        v-if="loading"
        class="editor-loading"
      >
        <div class="editor-loading-spinner" />
        <span>Loading account...</span>
      </div>

      <template v-else-if="integration">
        <!-- Hero card: integration identity + status -->
        <div class="editor-hero">
          <div class="editor-hero-icon">
            <img
              v-if="integrationIcon"
              :src="integrationIcon"
              :alt="integration.name"
              class="h-full w-full object-contain"
            >
            <span
              v-else
              class="editor-hero-icon-fallback"
            >{{ integration.name.slice(0, 2).toUpperCase() }}</span>
          </div>
          <div class="editor-hero-info">
            <h1 class="editor-hero-title">
              {{ isEditing ? accountLabel : integration.name }}
            </h1>
            <p class="editor-hero-subtitle">
              {{ isEditing ? integration.name : integration.description }}
            </p>
            <div
              v-if="isEditing"
              class="editor-hero-badges"
            >
              <span class="editor-badge editor-badge-connected">Connected</span>
              <span class="editor-badge editor-badge-type">{{ integration.category }}</span>
            </div>
          </div>
        </div>

        <!-- OAuth section -->
        <div
          v-if="(integration.authType === 'oauth' || integration.oauth) && !isEditing"
          class="editor-card"
        >
          <button
            type="button"
            class="editor-oauth-btn"
            :disabled="saving"
            @click="handleOAuthConnect"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4">
              <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
              <polyline points="10 17 15 12 10 7" />
              <line x1="15" y1="12" x2="3" y2="12" />
            </svg>
            Sign in with {{ integration.name }}
          </button>
          <p
            v-if="oauthError"
            class="editor-error-text mt-3"
          >
            {{ oauthError }}
          </p>
          <div
            v-if="integration.properties && integration.properties.length > 0"
            class="editor-divider"
          >
            <span>or enter credentials manually</span>
          </div>
        </div>

        <!-- Credentials card -->
        <div class="editor-card">
          <div class="editor-card-header">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="editor-card-header-icon">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
              <path d="M7 11V7a5 5 0 0 1 10 0v4" />
            </svg>
            <h2 class="editor-card-title">
              {{ isEditing ? 'Credentials' : 'New Connection' }}
            </h2>
          </div>

          <!-- Account label (new accounts only) -->
          <div
            v-if="!isEditing"
            class="editor-field"
          >
            <label class="editor-label">
              Account Name <span class="editor-required">*</span>
            </label>
            <input
              v-model="accountLabel"
              type="text"
              placeholder="e.g. Work Account, Personal"
              class="editor-input"
              :class="{ 'editor-input-error': errors.__account_label }"
            >
            <p class="editor-hint">
              A friendly name to identify this connection in your vault
            </p>
            <p
              v-if="errors.__account_label"
              class="editor-error-text"
            >
              {{ errors.__account_label }}
            </p>
          </div>

          <!-- Property fields -->
          <div
            v-for="property in visibleProperties"
            :key="property.key"
            class="editor-field"
          >
            <label
              :for="'field-' + property.key"
              class="editor-label"
            >
              {{ property.title }}
              <span
                v-if="property.required"
                class="editor-required"
              >*</span>
            </label>

            <!-- Select field -->
            <div
              v-if="property.type === 'select'"
              class="editor-select-wrap"
            >
              <select
                :id="'field-' + property.key"
                v-model="formData[property.key]"
                class="editor-select"
                :class="{ 'editor-input-error': errors[property.key] }"
                :disabled="selectOptionsLoading[property.key]"
              >
                <option
                  value=""
                  disabled
                >
                  {{ selectOptionsLoading[property.key] ? 'Loading options...' : (property.placeholder || 'Choose...') }}
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
                class="editor-select-refresh"
                title="Refresh options"
                @click="fetchSelectOptions(property)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3.5 w-3.5">
                  <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              </button>
            </div>

            <!-- Password field with eye toggle + generate button -->
            <div
              v-else-if="property.type === 'password'"
              class="editor-password-wrap"
            >
              <input
                :id="'field-' + property.key"
                v-model="formData[property.key]"
                :type="passwordVisible[property.key] ? 'text' : 'password'"
                :placeholder="property.placeholder || '••••••••'"
                class="editor-input editor-input-password"
                :class="{ 'editor-input-error': errors[property.key] }"
                @blur="onDependencyFieldBlur(property.key)"
              >
              <button
                type="button"
                class="editor-gen-btn"
                title="Generate password"
                @click="$emit('open-generator', property.key)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3.5 w-3.5">
                  <rect x="2" y="4" width="20" height="16" rx="2" />
                  <path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M6 16h8" />
                </svg>
              </button>
              <button
                type="button"
                class="editor-eye-btn"
                :title="passwordVisible[property.key] ? 'Hide' : 'Show'"
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
              class="editor-input"
              :class="{ 'editor-input-error': errors[property.key] }"
              @blur="onDependencyFieldBlur(property.key)"
            >

            <p
              v-if="property.hint"
              class="editor-hint"
            >
              {{ property.hint }}
            </p>
            <p
              v-if="errors[property.key]"
              class="editor-error-text"
            >
              {{ errors[property.key] }}
            </p>
          </div>
        </div>

        <!-- Actions card -->
        <div class="editor-actions">
          <button
            type="button"
            class="editor-btn-primary"
            :disabled="saving"
            @click="handleSave"
          >
            <svg
              v-if="saving"
              class="animate-spin h-4 w-4"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4" />
              <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {{ saving ? 'Saving...' : (isEditing ? 'Save Changes' : 'Connect Account') }}
          </button>
          <button
            type="button"
            class="editor-btn-secondary"
            @click="$emit('back')"
          >
            Cancel
          </button>
        </div>

        <!-- Danger zone (edit mode only) -->
        <div
          v-if="isEditing"
          class="editor-danger"
        >
          <div class="editor-danger-inner">
            <div>
              <h3 class="editor-danger-title">
                Remove Connection
              </h3>
              <p class="editor-danger-desc">
                This will permanently delete this account and all its saved credentials.
              </p>
            </div>
            <button
              type="button"
              class="editor-btn-danger"
              :disabled="saving"
              @click="handleDelete"
            >
              Delete Account
            </button>
          </div>
        </div>

        <!-- Installation guide (collapsible) -->
        <details
          v-if="integration.installationGuide"
          class="editor-guide"
        >
          <summary class="editor-guide-summary">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4">
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            Setup Guide
          </summary>
          <div class="editor-guide-content">
            <p
              v-if="integration.installationGuide.description"
              class="editor-guide-desc"
            >
              {{ integration.installationGuide.description }}
            </p>
            <div
              v-for="(step, i) in integration.installationGuide.steps"
              :key="i"
              class="editor-guide-step"
            >
              <div class="editor-guide-step-num">
                {{ i + 1 }}
              </div>
              <div class="editor-guide-step-body">
                <h4 class="editor-guide-step-title">
                  {{ step.title }}
                </h4>
                <pre class="editor-guide-step-content">{{ step.content }}</pre>
              </div>
            </div>
          </div>
        </details>
      </template>
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
  prefillPassword?: string;
}>();

const emit = defineEmits<{
  back: [];
  saved: [accountId: string];
  deleted: [];
  'open-generator': [fieldKey: string];
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

const visibleProperties = computed(() => {
  if (!integration.value?.properties) return [];
  return integration.value.properties;
});

const integrationIcon = computed(() => {
  if (!integration.value?.icon) return null;
  try {
    return require(`@pkg/assets/images/${ integration.value.icon }`);
  } catch {
    return null;
  }
});

async function loadIntegration() {
  loading.value = true;
  try {
    await integrationService.initialize();
    const extensionService = getExtensionService();
    await extensionService.initialize();
    const catalog: Record<string, Integration> = { ...baseCatalog };
    for (const ext of extensionService.getExtensionIntegrations()) {
      catalog[ext.id] = ext;
    }

    integration.value = catalog[props.integrationId] || null;

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

onMounted(() => loadIntegration());

// Prefill password when returning from the generator
watch(() => props.prefillPassword, (pw) => {
  if (pw) {
    // Find the first password property and fill it
    const pwProp = integration.value?.properties?.find(p => p.type === 'password');
    if (pwProp) {
      formData.value[pwProp.key] = pw;
    }
  }
});

watch(() => [props.integrationId, props.accountId], () => {
  formData.value = {};
  errors.value = {};
  accountLabel.value = '';
  loadIntegration();
});
</script>

<style scoped>
.account-editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}

/* ── Header ── */
.editor-header {
  display: flex;
  align-items: center;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-default, #21262d);
  background: var(--bg-surface-alt, #161b22);
}

.editor-back-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary, #8b949e);
  background: none;
  border: none;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}

.editor-back-btn:hover {
  color: var(--text-primary, #e6edf3);
  background: var(--bg-surface-hover, #1c2128);
}

/* ── Scroll area ── */
.editor-scroll {
  flex: 1;
  overflow-y: auto;
  padding: 24px 20px 40px;
}

.editor-scroll > * + * {
  margin-top: 20px;
}

/* ── Loading ── */
.editor-loading {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 60px 0;
  color: var(--text-muted, #484f58);
  font-size: 13px;
}

.editor-loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-default, #21262d);
  border-top-color: var(--accent-primary, #38bdf8);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ── Hero card ── */
.editor-hero {
  display: flex;
  align-items: flex-start;
  gap: 16px;
  padding: 20px;
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
}

.editor-hero-icon {
  flex-shrink: 0;
  width: 48px;
  height: 48px;
  border-radius: 12px;
  overflow: hidden;
  background: var(--bg-surface, #0d1117);
  border: 1px solid var(--border-default, #21262d);
  display: flex;
  align-items: center;
  justify-content: center;
}

.editor-hero-icon-fallback {
  font-size: 16px;
  font-weight: 700;
  color: var(--accent-primary, #38bdf8);
  letter-spacing: 0.05em;
}

.editor-hero-info {
  flex: 1;
  min-width: 0;
}

.editor-hero-title {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary, #e6edf3);
  margin: 0 0 4px;
  line-height: 1.3;
}

.editor-hero-subtitle {
  font-size: 13px;
  color: var(--text-secondary, #8b949e);
  margin: 0;
  line-height: 1.5;
}

.editor-hero-badges {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.editor-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 20px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.editor-badge-connected {
  background: rgba(56, 189, 248, 0.12);
  color: var(--accent-primary, #38bdf8);
}

.editor-badge-type {
  background: var(--bg-surface, #0d1117);
  color: var(--text-secondary, #8b949e);
  border: 1px solid var(--border-default, #21262d);
}

/* ── Cards ── */
.editor-card {
  padding: 20px;
  background: var(--bg-surface-alt, #161b22);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
}

.editor-card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 20px;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border-default, #21262d);
}

.editor-card-header-icon {
  width: 20px;
  height: 20px;
  color: var(--accent-primary, #38bdf8);
}

.editor-card-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text-primary, #e6edf3);
  margin: 0;
}

/* ── Fields ── */
.editor-field {
  margin-bottom: 16px;
}

.editor-field:last-child {
  margin-bottom: 0;
}

.editor-label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary, #8b949e);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.editor-required {
  color: #f85149;
}

.editor-input {
  width: 100%;
  padding: 10px 14px;
  font-size: 14px;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
}

.editor-input:focus {
  border-color: var(--accent-primary, #38bdf8);
  box-shadow: 0 0 0 3px rgba(56, 189, 248, 0.15);
}

.editor-input-error {
  border-color: #f85149 !important;
}

.editor-input::placeholder {
  color: var(--text-muted, #484f58);
}

.editor-hint {
  font-size: 11px;
  color: var(--text-muted, #484f58);
  margin-top: 4px;
  line-height: 1.4;
}

.editor-error-text {
  font-size: 12px;
  color: #f85149;
  margin-top: 4px;
}

/* ── Password field ── */
.editor-password-wrap {
  position: relative;
}

.editor-input-password {
  padding-right: 76px;
  font-family: 'SF Mono', Monaco, 'Cascadia Code', monospace;
  letter-spacing: 0.1em;
}

.editor-gen-btn {
  position: absolute;
  right: 36px;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  padding: 0 6px;
  color: var(--accent-primary, #38bdf8);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s;
  opacity: 0.7;
}

.editor-gen-btn:hover {
  opacity: 1;
}

.editor-eye-btn {
  position: absolute;
  right: 0;
  top: 0;
  bottom: 0;
  display: flex;
  align-items: center;
  padding: 0 12px;
  color: var(--text-muted, #484f58);
  background: none;
  border: none;
  cursor: pointer;
  transition: color 0.15s;
}

.editor-eye-btn:hover {
  color: var(--text-primary, #e6edf3);
}

/* ── Select field ── */
.editor-select-wrap {
  display: flex;
  gap: 8px;
}

.editor-select {
  flex: 1;
  padding: 10px 14px;
  font-size: 14px;
  background: var(--bg-surface, #0d1117);
  color: var(--text-primary, #e6edf3);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  outline: none;
  transition: border-color 0.15s;
}

.editor-select:focus {
  border-color: var(--accent-primary, #38bdf8);
}

.editor-select-refresh {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  background: var(--bg-surface, #0d1117);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  color: var(--text-muted, #484f58);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.editor-select-refresh:hover {
  color: var(--text-primary, #e6edf3);
  border-color: var(--text-secondary, #8b949e);
}

/* ── OAuth ── */
.editor-oauth-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  font-size: 14px;
  font-weight: 600;
  background: var(--accent-primary, #38bdf8);
  color: var(--bg-surface, #0d1117);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.editor-oauth-btn:hover:not(:disabled) {
  background: #7dd3fc;
}

.editor-oauth-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.editor-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 16px;
  font-size: 12px;
  color: var(--text-muted, #484f58);
}

.editor-divider::before,
.editor-divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-default, #21262d);
}

/* ── Action buttons ── */
.editor-actions {
  display: flex;
  gap: 12px;
}

.editor-btn-primary {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 600;
  background: var(--accent-primary, #38bdf8);
  color: var(--bg-surface, #0d1117);
  border: none;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
}

.editor-btn-primary:hover:not(:disabled) {
  background: #7dd3fc;
}

.editor-btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.editor-btn-secondary {
  padding: 12px 20px;
  font-size: 14px;
  font-weight: 500;
  background: transparent;
  color: var(--text-secondary, #8b949e);
  border: 1px solid var(--border-default, #21262d);
  border-radius: 8px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.editor-btn-secondary:hover {
  color: var(--text-primary, #e6edf3);
  border-color: var(--text-secondary, #8b949e);
}

/* ── Danger zone ── */
.editor-danger {
  padding: 16px 20px;
  background: rgba(248, 81, 73, 0.06);
  border: 1px solid rgba(248, 81, 73, 0.2);
  border-radius: 12px;
}

.editor-danger-inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.editor-danger-title {
  font-size: 13px;
  font-weight: 600;
  color: #f85149;
  margin: 0 0 2px;
}

.editor-danger-desc {
  font-size: 12px;
  color: var(--text-muted, #484f58);
  margin: 0;
}

.editor-btn-danger {
  flex-shrink: 0;
  padding: 8px 16px;
  font-size: 12px;
  font-weight: 600;
  background: transparent;
  color: #f85149;
  border: 1px solid rgba(248, 81, 73, 0.3);
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
}

.editor-btn-danger:hover:not(:disabled) {
  background: rgba(248, 81, 73, 0.12);
  border-color: #f85149;
}

.editor-btn-danger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ── Installation guide ── */
.editor-guide {
  border: 1px solid var(--border-default, #21262d);
  border-radius: 12px;
  overflow: hidden;
}

.editor-guide-summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 14px 20px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary, #8b949e);
  background: var(--bg-surface-alt, #161b22);
  cursor: pointer;
  list-style: none;
  transition: color 0.15s;
}

.editor-guide-summary::-webkit-details-marker {
  display: none;
}

.editor-guide-summary:hover {
  color: var(--text-primary, #e6edf3);
}

.editor-guide-content {
  padding: 16px 20px 20px;
  background: var(--bg-surface-alt, #161b22);
  border-top: 1px solid var(--border-default, #21262d);
}

.editor-guide-desc {
  font-size: 13px;
  color: var(--text-secondary, #8b949e);
  margin: 0 0 16px;
  line-height: 1.5;
}

.editor-guide-step {
  display: flex;
  gap: 12px;
  margin-top: 12px;
}

.editor-guide-step-num {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--bg-surface, #0d1117);
  border: 1px solid var(--border-default, #21262d);
  font-size: 11px;
  font-weight: 700;
  color: var(--accent-primary, #38bdf8);
}

.editor-guide-step-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary, #e6edf3);
  margin: 0 0 4px;
}

.editor-guide-step-content {
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  white-space: pre-wrap;
  margin: 0;
  font-family: inherit;
  line-height: 1.5;
}
</style>
