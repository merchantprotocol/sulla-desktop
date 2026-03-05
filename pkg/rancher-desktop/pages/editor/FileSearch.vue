<template>
  <div class="search-container" :class="{ dark: isDark }">
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

    <div v-if="indexing" class="status-bar" :class="{ dark: isDark }">
      Indexing...
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

      <div v-if="modelValue && !results.length && !indexing" class="no-results" :class="{ dark: isDark }">
        No results found
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';

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
  },

  emits: ['update:modelValue', 'update:searchPath', 'file-selected'],

  mounted() {
    (this.$refs.searchInput as HTMLInputElement)?.focus();
  },

  methods: {
    openResult(result: SearchResult) {
      const ext = result.name.includes('.') ? result.name.split('.').pop() || '' : '';

      this.$emit('file-selected', {
        name:  result.name,
        path:  result.path,
        isDir: false,
        size:  0,
        ext,
      });
    },
  },
});
</script>

<style scoped>
.search-container {
  display: flex;
  flex-direction: column;
  padding: 8px 12px;
  background: #f8fafc;
  border-bottom: 1px solid #e2e8f0;
  height: 100%;
  overflow: hidden;
}

.search-container.dark {
  background: #1e293b;
  border-bottom-color: #3c3c3c;
}

.search-input-wrapper {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
}

.search-input-wrapper.dark {
  background: #2d2d2d;
  border-color: #404040;
}

.path-input-wrapper {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  margin-top: 6px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: 4px;
}

.path-input-wrapper.dark {
  background: #252525;
  border-color: #3a3a3a;
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
  color: #ccc;
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
  color: #999;
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
  padding: 4px 8px;
  margin-top: 6px;
  font-size: 11px;
  color: #64748b;
}

.status-bar.dark {
  color: #8899a6;
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
  background: #333;
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
  background: #3a3a3a;
  color: #8899a6;
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
  color: #586e75;
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
  background: #3a3a3a;
  color: #8899a6;
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
