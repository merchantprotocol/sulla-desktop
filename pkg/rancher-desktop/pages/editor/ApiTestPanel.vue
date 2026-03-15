<template>
  <div
    class="api-test"
    :class="{ dark: isDark }"
  >
    <!-- Top bar: integration + endpoint selector -->
    <div
      class="api-bar"
      :class="{ dark: isDark }"
    >
      <select
        v-model="selectedSlug"
        class="api-select"
        :class="{ dark: isDark }"
        @change="onSlugChange"
      >
        <option
          value=""
          disabled
        >
          Integration
        </option>
        <option
          v-for="integ in integrations"
          :key="integ.slug"
          :value="integ.slug"
        >
          {{ integ.slug }}
        </option>
      </select>
      <select
        v-model="selectedEndpoint"
        class="api-select"
        :class="{ dark: isDark }"
        @change="onEndpointChange"
      >
        <option
          value=""
          disabled
        >
          Endpoint
        </option>
        <option
          v-for="ep in currentEndpoints"
          :key="ep.name"
          :value="ep.name"
        >
          {{ ep.method }} {{ ep.path }}
        </option>
      </select>
      <div
        class="api-method-badge"
        :class="[methodClass]"
      >
        {{ currentMethod }}
      </div>
      <input
        v-model="fullUrl"
        class="api-url-input"
        :class="{ dark: isDark }"
        readonly
        placeholder="URL will appear here"
      >
      <button
        class="api-send-btn"
        :class="{ dark: isDark, loading: sending }"
        :disabled="sending || !selectedEndpoint"
        @click="sendRequest"
      >
        {{ sending ? 'Sending...' : 'Send' }}
      </button>
    </div>

    <div class="api-body-wrapper">
      <!-- Left: params editor -->
      <div
        class="api-params"
        :class="{ dark: isDark }"
      >
        <div
          class="api-params-header"
          :class="{ dark: isDark }"
        >
          <button
            v-for="tab in paramTabs"
            :key="tab"
            class="api-params-tab"
            :class="{ active: activeParamTab === tab, dark: isDark }"
            @click="activeParamTab = tab"
          >
            {{ tab }}
          </button>
        </div>
        <div class="api-params-body">
          <!-- Params tab -->
          <div
            v-if="activeParamTab === 'Params'"
            class="api-kv-list"
          >
            <div
              v-if="paramRows.length === 0"
              class="api-kv-empty"
            >
              No query parameters defined
            </div>
            <div
              v-for="(row, i) in paramRows"
              :key="i"
              class="api-kv-row"
              :class="{ dark: isDark }"
            >
              <input
                v-model="row.enabled"
                class="api-kv-check"
                type="checkbox"
              >
              <input
                v-model="row.key"
                class="api-kv-key"
                :class="{ dark: isDark }"
                placeholder="Key"
                readonly
              >
              <input
                v-model="row.value"
                class="api-kv-value"
                :class="{ dark: isDark }"
                :placeholder="row.hint || 'Value'"
                @input="rebuildUrl"
              >
              <span
                v-if="row.required"
                class="api-kv-req"
              >*</span>
            </div>
          </div>
          <!-- Headers tab -->
          <div
            v-if="activeParamTab === 'Headers'"
            class="api-kv-list"
          >
            <div
              v-for="(row, i) in headerRows"
              :key="i"
              class="api-kv-row"
              :class="{ dark: isDark }"
            >
              <input
                v-model="row.enabled"
                class="api-kv-check"
                type="checkbox"
              >
              <input
                v-model="row.key"
                class="api-kv-key"
                :class="{ dark: isDark }"
                placeholder="Header name"
              >
              <input
                v-model="row.value"
                class="api-kv-value"
                :class="{ dark: isDark }"
                placeholder="Value"
              >
              <button
                class="api-kv-del"
                @click="headerRows.splice(i, 1)"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                ><line
                  x1="18"
                  y1="6"
                  x2="6"
                  y2="18"
                /><line
                  x1="6"
                  y1="6"
                  x2="18"
                  y2="18"
                /></svg>
              </button>
            </div>
            <button
              class="api-kv-add"
              :class="{ dark: isDark }"
              @click="headerRows.push({ key: '', value: '', enabled: true })"
            >
              + Add Header
            </button>
          </div>
          <!-- Body tab -->
          <div
            v-if="activeParamTab === 'Body'"
            class="api-body-editor"
          >
            <textarea
              v-model="requestBody"
              class="api-body-textarea"
              :class="{ dark: isDark }"
              placeholder="{ &quot;key&quot;: &quot;value&quot; }"
              rows="8"
            />
          </div>
          <!-- Auth tab -->
          <div
            v-if="activeParamTab === 'Auth'"
            class="api-auth-section"
          >
            <div
              class="api-auth-info"
              :class="{ dark: isDark }"
            >
              <span v-if="authType">Type: <strong>{{ authType }}</strong></span>
              <span v-else>No auth configured</span>
            </div>
            <div
              class="api-kv-row"
              :class="{ dark: isDark }"
            >
              <span class="api-kv-label">API Key</span>
              <input
                v-model="overrideApiKey"
                class="api-kv-value"
                :class="{ dark: isDark }"
                placeholder="Override API key (optional)"
              >
            </div>
            <div
              class="api-kv-row"
              :class="{ dark: isDark }"
            >
              <span class="api-kv-label">Token</span>
              <input
                v-model="overrideToken"
                class="api-kv-value"
                :class="{ dark: isDark }"
                placeholder="Override Bearer token (optional)"
              >
            </div>
          </div>
        </div>
      </div>

      <!-- Right: response viewer -->
      <div
        class="api-response"
        :class="{ dark: isDark }"
      >
        <div
          class="api-response-header"
          :class="{ dark: isDark }"
        >
          <span class="api-response-title">Response</span>
          <span
            v-if="responseStatus"
            class="api-response-status"
            :class="statusClass"
          >{{ responseStatus }}</span>
          <span
            v-if="responseTime"
            class="api-response-time"
          >{{ responseTime }}ms</span>
        </div>
        <div
          v-if="responseError"
          class="api-response-error"
        >
          {{ responseError }}
        </div>
        <pre
          v-else-if="responseBody"
          class="api-response-body"
          :class="{ dark: isDark }"
        >{{ responseBody }}</pre>
        <div
          v-else
          class="api-response-empty"
        >
          Send a request to see the response
        </div>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, reactive, computed, onMounted, watch } from 'vue';
import { ipcRenderer } from 'electron';

interface IntegrationInfo {
  slug:      string;
  name:      string;
  baseUrl:   string;
  version:   string;
  endpoints: EndpointInfo[];
}

interface EndpointInfo {
  name:        string;
  path:        string;
  method:      string;
  description: string;
  auth:        string;
  queryParams: {
    key:          string;
    type?:        string;
    required?:    boolean;
    default?:     any;
    description?: string;
    enum?:        string[];
  }[];
}

interface KVRow {
  key:       string;
  value:     string;
  enabled:   boolean;
  hint?:     string;
  required?: boolean;
}

export default defineComponent({
  name: 'ApiTestPanel',

  props: {
    isDark:      { type: Boolean, default: false },
    initialSlug: { type: String, default: '' },
  },

  emits: ['close'],

  setup(props) {
    const integrations = ref<IntegrationInfo[]>([]);
    const selectedSlug = ref('');
    const selectedEndpoint = ref('');
    const paramRows = ref<KVRow[]>([]);
    const headerRows = ref<KVRow[]>([{ key: 'Accept', value: 'application/json', enabled: true }]);
    const requestBody = ref('');
    const overrideApiKey = ref('');
    const overrideToken = ref('');
    const activeParamTab = ref('Params');
    const paramTabs = ['Params', 'Headers', 'Body', 'Auth'];

    const sending = ref(false);
    const responseBody = ref('');
    const responseError = ref('');
    const responseStatus = ref('');
    const responseTime = ref(0);

    const fullUrl = ref('');

    const currentIntegration = computed(() =>
      integrations.value.find(i => i.slug === selectedSlug.value),
    );

    const currentEndpoints = computed(() =>
      currentIntegration.value?.endpoints || [],
    );

    const currentEndpointInfo = computed(() =>
      currentEndpoints.value.find(e => e.name === selectedEndpoint.value),
    );

    const currentMethod = computed(() =>
      currentEndpointInfo.value?.method || 'GET',
    );

    const authType = computed(() => {
      // Auth type comes from the integration-level config
      return currentEndpointInfo.value?.auth || '';
    });

    const methodClass = computed(() => {
      const m = currentMethod.value.toLowerCase();
      return `method-${ m }`;
    });

    const statusClass = computed(() => {
      const code = parseInt(responseStatus.value, 10);
      if (code >= 200 && code < 300) return 'status-ok';
      if (code >= 400 && code < 500) return 'status-client-err';
      if (code >= 500) return 'status-server-err';
      return '';
    });

    async function loadIntegrations() {
      try {
        integrations.value = await ipcRenderer.invoke('configapi-list-integrations');
      } catch (err) {
        console.error('[ApiTestPanel] Failed to load integrations:', err);
      }
    }

    function onSlugChange() {
      selectedEndpoint.value = '';
      paramRows.value = [];
      fullUrl.value = '';
      const integ = currentIntegration.value;
      if (integ && integ.endpoints.length > 0) {
        selectedEndpoint.value = integ.endpoints[0].name;
        onEndpointChange();
      }
    }

    function onEndpointChange() {
      const ep = currentEndpointInfo.value;
      const integ = currentIntegration.value;
      if (!ep || !integ) {
        paramRows.value = [];
        fullUrl.value = '';
        return;
      }

      // Build param rows from YAML query_params
      paramRows.value = ep.queryParams.map(p => ({
        key:      p.key,
        value:    p.default != null ? String(p.default) : '',
        enabled:  !!p.required || p.default != null,
        hint:     p.description || '',
        required: !!p.required,
      }));

      rebuildUrl();
    }

    function rebuildUrl() {
      const integ = currentIntegration.value;
      const ep = currentEndpointInfo.value;
      if (!integ || !ep) {
        fullUrl.value = '';
        return;
      }

      let url = integ.baseUrl.replace(/\/+$/, '') + ep.path;
      const enabledParams = paramRows.value.filter(r => r.enabled && r.value);
      if (enabledParams.length > 0) {
        const qs = enabledParams.map(r => `${ encodeURIComponent(r.key) }=${ encodeURIComponent(r.value) }`).join('&');
        url += '?' + qs;
      }
      fullUrl.value = url;
    }

    async function sendRequest() {
      if (!selectedSlug.value || !selectedEndpoint.value) return;

      sending.value = true;
      responseBody.value = '';
      responseError.value = '';
      responseStatus.value = '';
      responseTime.value = 0;

      // Build params object from enabled rows
      const params: Record<string, any> = {};
      for (const row of paramRows.value) {
        if (row.enabled && row.value) {
          params[row.key] = row.value;
        }
      }

      const options: any = { raw: true };
      if (overrideToken.value) options.token = overrideToken.value;
      if (overrideApiKey.value) options.apiKey = overrideApiKey.value;

      // Build custom headers
      const customHeaders: Record<string, string> = {};
      for (const h of headerRows.value) {
        if (h.enabled && h.key && h.value) {
          customHeaders[h.key] = h.value;
        }
      }
      if (Object.keys(customHeaders).length > 0) {
        options.headers = customHeaders;
      }

      // Body
      if (requestBody.value.trim()) {
        try {
          options.body = JSON.parse(requestBody.value);
        } catch {
          responseError.value = 'Invalid JSON in request body';
          sending.value = false;
          return;
        }
      }

      const start = performance.now();
      try {
        const result = await ipcRenderer.invoke(
          'configapi-call',
          selectedSlug.value,
          selectedEndpoint.value,
          params,
          options,
        );
        responseTime.value = Math.round(performance.now() - start);
        responseStatus.value = '200';
        responseBody.value = JSON.stringify(result, null, 2);
      } catch (err: any) {
        responseTime.value = Math.round(performance.now() - start);
        const msg = err?.message || String(err);
        const statusMatch = msg.match(/returned (\d{3}):/);
        responseStatus.value = statusMatch ? statusMatch[1] : 'ERR';
        responseError.value = msg;
      }
      sending.value = false;
    }

    onMounted(() => {
      loadIntegrations();
    });

    // Auto-rebuild URL when params change
    watch(paramRows, rebuildUrl, { deep: true });

    // When parent sets initialSlug, select that integration
    watch(() => props.initialSlug, async(slug) => {
      if (!slug) return;
      // Ensure integrations are loaded
      if (integrations.value.length === 0) {
        await loadIntegrations();
      }
      if (integrations.value.find(i => i.slug === slug)) {
        selectedSlug.value = slug;
        onSlugChange();
      }
    }, { immediate: true });

    return {
      integrations,
      selectedSlug,
      selectedEndpoint,
      currentEndpoints,
      currentMethod,
      methodClass,
      authType,
      paramTabs,
      activeParamTab,
      paramRows,
      headerRows,
      requestBody,
      overrideApiKey,
      overrideToken,
      fullUrl,
      sending,
      responseBody,
      responseError,
      responseStatus,
      responseTime,
      statusClass,
      onSlugChange,
      onEndpointChange,
      rebuildUrl,
      sendRequest,
    };
  },
});
</script>

<style scoped>
.api-test {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  font-size: var(--fs-code);
  background: var(--bg-page);
}

/* ── Top bar ───────────────────────────────────── */
.api-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.api-select {
  padding: 4px 8px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  font-size: var(--fs-body-sm);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  max-width: 140px;
}

.api-method-badge {
  padding: 3px 8px;
  border-radius: 4px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  flex-shrink: 0;
}
.method-get { background: var(--bg-success); color: var(--text-success); }
.method-post { background: var(--bg-warning); color: var(--text-warning); }
.method-put { background: var(--bg-info); color: var(--text-info); }
.method-delete { background: var(--bg-error); color: var(--text-error); }
.method-patch { background: var(--bg-accent); color: var(--text-accent); }

.api-url-input {
  flex: 1;
  padding: 5px 8px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
  min-width: 0;
}

.api-send-btn {
  padding: 5px 16px;
  border: none;
  border-radius: 4px;
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  cursor: pointer;
  background: var(--accent-primary);
  color: var(--text-on-accent);
  flex-shrink: 0;
  transition: background 0.15s;
}
.api-send-btn:hover { background: var(--accent-primary-hover); }
.api-send-btn:disabled { opacity: 0.5; cursor: default; }
.api-send-btn.loading { background: var(--text-secondary); }

/* ── Body wrapper (split) ──────────────────────── */
.api-body-wrapper {
  display: flex;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Params editor (left half) ─────────────────── */
.api-params {
  width: 50%;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border-default);
  overflow: hidden;
  min-height: 0;
}

.api-params-header {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.api-params-tab {
  padding: 5px 12px;
  border: none;
  background: transparent;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  cursor: pointer;
  border-bottom: 2px solid transparent;
}
.api-params-tab.active { color: var(--text-info); border-bottom-color: var(--accent-primary); }

.api-params-body {
  flex: 1;
  overflow-y: auto;
  padding: 6px;
}

/* KV rows */
.api-kv-list { display: flex; flex-direction: column; gap: 3px; }
.api-kv-empty { padding: 12px; color: var(--text-muted); text-align: center; font-size: var(--fs-body-sm); }

.api-kv-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 0;
}

.api-kv-check { width: 14px; height: 14px; flex-shrink: 0; }

.api-kv-key, .api-kv-value {
  padding: 3px 6px;
  border: 1px solid var(--border-default);
  border-radius: 3px;
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  outline: none;
  background: var(--bg-surface);
  color: var(--text-primary);
}
.api-kv-key { width: 120px; flex-shrink: 0; }
.api-kv-value { flex: 1; min-width: 0; }
.api-kv-req { color: var(--text-error); font-weight: var(--weight-bold); font-size: var(--fs-body); }
.api-kv-label { font-size: var(--fs-body-sm); color: var(--text-muted); width: 60px; flex-shrink: 0; }
.api-kv-del {
  border: none; background: none; cursor: pointer; color: var(--text-muted); padding: 2px;
}
.api-kv-add {
  border: none; background: none; color: var(--text-info); cursor: pointer; font-size: var(--fs-body-sm);
  padding: 4px 0; text-align: left;
}

/* Body textarea */
.api-body-editor { height: 100%; }
.api-body-textarea {
  width: 100%;
  height: 100%;
  resize: none;
  border: none;
  padding: 8px;
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  background: var(--bg-surface);
  color: var(--text-primary);
  outline: none;
}

/* Auth section */
.api-auth-section { padding: 8px 0; display: flex; flex-direction: column; gap: 8px; }
.api-auth-info { font-size: var(--fs-body-sm); color: var(--text-muted); padding: 0 4px; }

/* ── Response viewer (right half) ──────────────── */
.api-response {
  width: 50%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
}

.api-response-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-default);
  flex-shrink: 0;
}

.api-response-title { font-size: var(--fs-body-sm); font-weight: var(--weight-semibold); color: var(--text-muted); }
.api-response-status {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-bold);
  padding: 1px 6px;
  border-radius: 3px;
}
.status-ok { background: var(--bg-success); color: var(--text-success); }
.status-client-err { background: var(--bg-warning); color: var(--text-warning); }
.status-server-err { background: var(--bg-error); color: var(--text-error); }

.api-response-time { font-size: var(--fs-caption); color: var(--text-muted); }

.api-response-body {
  flex: 1;
  overflow-y: auto;
  padding: 8px 10px;
  margin: 0;
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--text-primary);
  background: var(--bg-surface);
  min-height: 0;
}

.api-response-error {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  color: var(--text-error);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
  white-space: pre-wrap;
  word-break: break-all;
  min-height: 0;
}

.api-response-empty {
  padding: 24px;
  text-align: center;
  color: var(--text-muted);
  font-size: var(--fs-body-sm);
}
</style>
