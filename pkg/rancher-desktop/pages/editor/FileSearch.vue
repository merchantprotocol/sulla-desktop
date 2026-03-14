<template>
  <div class="search-container" :class="{ dark: isDark }">
    <div class="search-pane-header" :class="{ dark: isDark }">
      <span class="search-pane-title">Search</span>
      <button class="search-close-btn" :class="{ dark: isDark }" title="Close Panel" @click="$emit('close')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </button>
    </div>
    <div class="search-input-wrapper" :class="{ dark: isDark }">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <path d="m21 21-4.35-4.35"/>
      </svg>
      <input
        ref="searchInput"
        :value="modelValue"
        @input="$emit('update:modelValue', ($event.target as HTMLInputElement).value)"
        placeholder="Search files..."
        class="search-input"
        :class="{ dark: isDark }"
      />
    </div>

    <div class="path-input-wrapper" :class="{ dark: isDark }">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
      </svg>
      <input
        :value="searchPath"
        @input="$emit('update:searchPath', ($event.target as HTMLInputElement).value)"
        placeholder="Search path..."
        class="path-input"
        :class="{ dark: isDark }"
      />
    </div>

    <div v-if="indexing || searching" class="status-bar" :class="{ dark: isDark }">
      <span class="spinner" />
      {{ indexing ? 'Indexing...' : 'Searching...' }}
    </div>

    <div class="results-list" :class="{ dark: isDark }">
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
        <div class="result-path" :class="{ dark: isDark }">
          {{ result.path }}
        </div>
        <div v-if="result.preview && result.source === 'fts'" class="result-preview" :class="{ dark: isDark }">
          <span v-if="result.line" class="result-line">L{{ result.line }}</span>
          {{ result.preview }}
        </div>
      </div>

      <div v-if="modelValue && !results.length && !indexing && !searching" class="no-results" :class="{ dark: isDark }">
        No results found
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';

const { ipcRenderer } = window.require('electron');

export interface SearchResult {
  path: string;
  name: string;
  line: number;
  preview: string;
  score: number;
  source: 'fts' | 'filename';
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
      // Open the file in VS Code at the matched line
      ipcRenderer.invoke('filesystem-open-in-editor', result.path, result.line || undefined);
    },
  },
});
</script>

<style scoped>
.search-container {
  display: flex;
  flex-direction: column;
  padding: 0;
  background: #f8fafc;
  height: 100%;
  overflow: hidden;
}

.search-container.dark {
  background: var(--bg-surface, #1e293b);
}

.search-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: #f8fafc;
  border-bottom: 1px solid #cbd5e1;
}

.search-pane-header.dark {
  background: var(--bg-surface, #1e293b);
  border-bottom-color: var(--border-default, #334155);
}

.search-pane-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.search-pane-header.dark .search-pane-title {
  color: #94a3b8;
}

.search-close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: #94a3b8;
  border-radius: 4px;
  cursor: pointer;
}

.search-close-btn:hover {
  background: rgba(0,0,0,0.06);
  color: #475569;
}

.search-close-btn.dark {
  color: #64748b;
}

.search-close-btn.dark:hover {
  background: rgba(255,255,255,0.08);
  color: #94a3b8;
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 8px 12px;
  padding: 8px 12px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
}

.search-input-wrapper.dark {
  background: #0f172a;
  border-color: var(--border-default, #334155);
}

.path-input-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  margin: 6px 12px 0 12px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
}

.path-input-wrapper.dark {
  background: #0f172a;
  border-color: var(--border-default, #334155);
}

.search-container svg {
  color: #64748b;
  flex-shrink: 0;
}

.search-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: #333;
  font-size: 13px;
}

.search-input.dark {
  color: #e2e8f0;
}

.path-input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  color: #666;
  font-size: 11px;
  font-family: monospace;
}

.path-input.dark {
  color: #94a3b8;
}

.search-input::placeholder,
.path-input::placeholder {
  color: #94a3b8;
}

.search-input.dark::placeholder,
.path-input.dark::placeholder {
  color: #64748b;
}

.status-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  margin-top: 6px;
  font-size: 11px;
  color: #64748b;
}

.status-bar.dark {
  color: #94a3b8;
}

.spinner {
  width: 12px;
  height: 12px;
  border: 2px solid #e2e8f0;
  border-top-color: #64748b;
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
}

.dark .spinner {
  border-color: var(--border-default, #334155);
  border-top-color: #94a3b8;
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
  background: #e2e8f0;
}

.result-item.dark:hover {
  background: rgba(255, 255, 255, 0.06);
}

.result-name {
  font-size: 13px;
  font-weight: 500;
  color: #1e293b;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dark .result-name {
  color: #e2e8f0;
}

.result-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 3px;
  font-size: 9px;
  font-weight: 700;
  background: #e2e8f0;
  color: #64748b;
  flex-shrink: 0;
}

.dark .result-icon {
  background: var(--border-default, #334155);
  color: #94a3b8;
}

.result-path {
  font-size: 11px;
  color: #94a3b8;
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-left: 22px;
}

.result-path.dark {
  color: #64748b;
}

.result-preview {
  font-size: 11px;
  color: #64748b;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding-left: 22px;
}

.result-preview.dark {
  color: #64748b;
}

.result-line {
  display: inline-block;
  padding: 0 4px;
  margin-right: 4px;
  border-radius: 2px;
  background: #e2e8f0;
  color: #64748b;
  font-size: 10px;
  font-weight: 600;
}

.dark .result-line {
  background: var(--border-default, #334155);
  color: #94a3b8;
}

.no-results {
  padding: 12px 8px;
  text-align: center;
  font-size: 12px;
  color: #94a3b8;
}

.no-results.dark {
  color: #64748b;
}
</style>
