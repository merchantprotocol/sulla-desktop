<template>
  <div
    class="search-container"
    :class="{ dark: isDark }"
  >
    <div
      class="search-pane-header"
      :class="{ dark: isDark }"
    >
      <span class="search-pane-title">Search</span>
      <button
        class="search-close-btn"
        :class="{ dark: isDark }"
        title="Close Panel"
        @click="$emit('close')"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <line
            x1="18"
            y1="6"
            x2="6"
            y2="18"
          />
          <line
            x1="6"
            y1="6"
            x2="18"
            y2="18"
          />
        </svg>
      </button>
    </div>
    <div
      class="search-input-wrapper"
      :class="{ dark: isDark }"
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <circle
          cx="11"
          cy="11"
          r="8"
        />
        <path d="m21 21-4.35-4.35" />
      </svg>
      <input
        ref="searchInput"
        :value="modelValue"
        placeholder="Search files..."
        class="search-input"
        :class="{ dark: isDark }"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      >
    </div>

    <div
      class="path-input-wrapper"
      :class="{ dark: isDark }"
    >
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
      </svg>
      <input
        :value="searchPath"
        placeholder="Search path..."
        class="path-input"
        :class="{ dark: isDark }"
        @input="$emit('update:searchPath', ($event.target as HTMLInputElement).value)"
      >
    </div>

    <div
      v-if="indexing || searching"
      class="status-bar"
      :class="{ dark: isDark }"
    >
      <span class="spinner" />
      {{ indexing ? 'Indexing...' : 'Searching...' }}
    </div>

    <div
      class="results-list"
      :class="{ dark: isDark }"
    >
      <div
        v-for="(result, idx) in results"
        :key="result.path + '-' + idx"
        class="result-item"
        :class="{ dark: isDark }"
        @click="openResult(result)"
      >
        <div class="result-name">
          <span class="result-icon">{{ result.source === 'fts' ? 'T' : 'F' }}</span>
          {{ result.name }}
        </div>
        <div
          class="result-path"
          :class="{ dark: isDark }"
        >
          {{ result.path }}
        </div>
        <div
          v-if="result.preview && result.source === 'fts'"
          class="result-preview"
          :class="{ dark: isDark }"
        >
          <span
            v-if="result.line"
            class="result-line"
          >L{{ result.line }}</span>
          {{ result.preview }}
        </div>
      </div>

      <div
        v-if="modelValue && !results.length && !indexing && !searching"
        class="no-results"
        :class="{ dark: isDark }"
      >
        No results found
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';

export interface SearchResult {
  path:    string;
  name:    string;
  line:    number;
  preview: string;
  score:   number;
  source:  'fts' | 'filename';
}

export default defineComponent({
  name: 'FileSearch',

  props: {
    modelValue: {
      type:    String,
      default: '',
    },
    isDark: {
      type:    Boolean,
      default: false,
    },
    searchPath: {
      type:    String,
      default: '',
    },
    results: {
      type:    Array as PropType<SearchResult[]>,
      default: () => [],
    },
    indexing: {
      type:    Boolean,
      default: false,
    },
    searching: {
      type:    Boolean,
      default: false,
    },
  },

  emits: ['update:modelValue', 'update:searchPath', 'file-selected', 'close'],

  mounted() {
    (this.$refs.searchInput as HTMLInputElement)?.focus();
  },

  methods: {
    openResult(result: SearchResult) {
      const name = result.path.split('/').pop() || result.name;
      const ext = name.includes('.') ? `.${ name.split('.').pop() }` : '';

      this.$emit('file-selected', {
        name,
        path:  result.path,
        isDir: false,
        size:  0,
        ext,
        line:  result.line || undefined,
      });
    },
  },
});
</script>

<style scoped>
.search-container {
  display: flex;
  flex-direction: column;
  padding: 0;
  background: var(--bg-surface);
  height: 100%;
  overflow: hidden;
}

.search-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-strong);
}

.search-pane-title {
  font-size: var(--fs-body-sm);
  font-weight: var(--weight-semibold);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wider);
  color: var(--text-secondary);
}

.search-pane-header.dark .search-pane-title {
  color: var(--text-muted);
}

.search-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 4px;
  cursor: pointer;
}

.search-close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-secondary);
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px;
  padding: 8px 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 6px;
}

.path-input-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  margin: 6px 12px 0 12px;
  background: var(--bg-input);
  border: 1px solid var(--border-default);
  border-radius: 4px;
}

.search-container svg {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-primary);
  font-size: var(--fs-code);
}

.path-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--fs-body-sm);
  font-family: var(--font-mono);
}

.path-input.dark {
  color: var(--text-muted);
}

.search-input::placeholder,
.path-input::placeholder {
  color: var(--text-muted);
}

.search-input.dark::placeholder,
.path-input.dark::placeholder {
  color: var(--text-secondary);
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-top: 6px;
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
}

.status-bar.dark {
  color: var(--text-muted);
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-default);
  border-top-color: var(--text-secondary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.dark .spinner {
  border-color: var(--border-default);
  border-top-color: var(--text-secondary);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.results-list {
  flex: 1;
  overflow-y: auto;
  margin-top: 8px;
}

.result-item {
  padding: 6px 8px;
  cursor: pointer;
  border-radius: 4px;
  margin-bottom: 2px;
}

.result-item:hover {
  background: var(--bg-surface-hover);
}

.result-name {
  font-size: var(--fs-code);
  font-weight: var(--weight-medium);
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 6px;
}

.result-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  font-size: var(--fs-caption);
  font-weight: var(--weight-bold);
  background: var(--bg-surface-hover);
  color: var(--text-secondary);
  flex-shrink: 0;
}

.result-path {
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-left: 22px;
}

.result-path.dark {
  color: var(--text-secondary);
}

.result-preview {
  font-size: var(--fs-body-sm);
  color: var(--text-secondary);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-left: 22px;
}

.result-preview.dark {
  color: var(--text-secondary);
}

.result-line {
  display: inline-block;
  padding: 0 4px;
  margin-right: 4px;
  border-radius: 2px;
  background: var(--bg-surface-hover);
  color: var(--text-secondary);
  font-size: var(--fs-caption);
  font-weight: var(--weight-semibold);
}

.no-results {
  padding: 12px 8px;
  text-align: center;
  font-size: var(--fs-code);
  color: var(--text-muted);
}

.no-results.dark {
  color: var(--text-secondary);
}
</style>
