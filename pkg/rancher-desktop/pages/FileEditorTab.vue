<template>
  <div class="file-editor-root">
    <div class="file-editor-bar">
      <span class="file-editor-name">{{ fileName }}</span>
      <span
        v-if="dirty"
        class="dirty-dot"
        title="Unsaved changes"
      >●</span>
      <span class="file-editor-path">{{ filePath }}</span>
      <button
        class="save-btn"
        :disabled="!dirty || saving"
        @click="save"
      >
        {{ saving ? 'Saving…' : 'Save' }}
      </button>
    </div>
    <div
      v-if="loadError"
      class="file-editor-error"
    >
      {{ loadError }}
    </div>
    <div
      ref="editorContainerRef"
      class="editor-container"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';
import * as monaco from 'monaco-editor';

(self as any).MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string): string {
    if (label === 'json') return '/json.worker.bundle.js';
    if (label === 'css' || label === 'scss' || label === 'less') return '/css.worker.bundle.js';
    if (label === 'html' || label === 'handlebars' || label === 'razor') return '/html.worker.bundle.js';
    if (label === 'typescript' || label === 'javascript') return '/ts.worker.bundle.js';
    return '/editor.worker.bundle.js';
  },
};

function extToLanguage(ext: string): string {
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    vue: 'html', html: 'html', htm: 'html',
    css: 'css', scss: 'scss', less: 'less',
    json: 'json', jsonc: 'json',
    md: 'markdown', mdx: 'markdown',
    py: 'python', rb: 'ruby', php: 'php',
    go: 'go', rs: 'rust', java: 'java',
    c: 'c', cpp: 'cpp', h: 'c',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    yaml: 'yaml', yml: 'yaml',
    xml: 'xml', svg: 'xml',
    sql: 'sql', graphql: 'graphql',
    dockerfile: 'dockerfile',
    toml: 'ini',
  };
  return map[ext.toLowerCase()] || 'plaintext';
}

export default defineComponent({
  name: 'FileEditorTab',

  props: {
    filePath: { type: String, required: true },
    isDark:   { type: Boolean, default: true },
  },

  setup(props) {
    const editorContainerRef = ref<HTMLDivElement | null>(null);
    const dirty     = ref(false);
    const saving    = ref(false);
    const loadError = ref('');

    let editor: monaco.editor.IStandaloneCodeEditor | null = null;
    let currentModel: monaco.editor.ITextModel | null = null;

    const fileName = computed(() => props.filePath.split('/').pop() || props.filePath);

    async function loadFile() {
      loadError.value = '';
      try {
        const content: string = await ipcRenderer.invoke('filesystem-read-file', props.filePath);
        const ext  = (props.filePath.split('.').pop() || '').toLowerCase();
        const lang = extToLanguage(ext);

        if (editor) {
          currentModel?.dispose();
          currentModel = monaco.editor.createModel(content, lang);
          editor.setModel(currentModel);
          dirty.value = false;

          editor.onDidChangeModelContent(() => {
            dirty.value = true;
          });
        }
      } catch (err: any) {
        loadError.value = err?.message || 'Failed to load file';
      }
    }

    async function save() {
      if (!currentModel || saving.value) return;
      saving.value = true;
      try {
        await ipcRenderer.invoke('filesystem-write-file', props.filePath, currentModel.getValue());
        dirty.value = false;
      } catch (err: any) {
        console.error('[FileEditorTab] save failed:', err);
      } finally {
        saving.value = false;
      }
    }

    function onGlobalKeydown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        save();
      }
    }

    onMounted(async () => {
      if (!editorContainerRef.value) return;

      editor = monaco.editor.create(editorContainerRef.value, {
        value:                '',
        language:             'plaintext',
        theme:                props.isDark ? 'vs-dark' : 'vs',
        fontSize:             13,
        fontFamily:           '"JetBrains Mono", "Fira Code", Menlo, Monaco, "Courier New", monospace',
        fontLigatures:        true,
        lineNumbers:          'on',
        minimap:              { enabled: false },
        scrollBeyondLastLine: false,
        automaticLayout:      true,
        wordWrap:             'off',
        renderWhitespace:     'none',
        folding:              true,
        padding:              { top: 8, bottom: 8 },
        smoothScrolling:      true,
        cursorBlinking:       'smooth',
        renderLineHighlight:  'all',
        bracketPairColorization: { enabled: true },
      });

      await loadFile();
      window.addEventListener('keydown', onGlobalKeydown);
    });

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onGlobalKeydown);
      currentModel?.dispose();
      editor?.dispose();
    });

    watch(() => props.isDark, (dark) => {
      monaco.editor.setTheme(dark ? 'vs-dark' : 'vs');
    });

    watch(() => props.filePath, () => {
      dirty.value = false;
      loadFile();
    });

    return {
      editorContainerRef,
      fileName,
      filePath: computed(() => props.filePath),
      dirty,
      saving,
      loadError,
      save,
    };
  },
});
</script>

<style scoped>
.file-editor-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}

.file-editor-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px;
  height: 35px;
  flex-shrink: 0;
  background: var(--bg-surface-alt, var(--bg-surface));
  border-bottom: 1px solid var(--border-default);
  font-family: var(--font-mono, monospace);
  font-size: 12px;
}

.file-editor-name {
  font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}

.dirty-dot {
  color: var(--accent-primary, #5096b3);
  font-size: 10px;
  line-height: 1;
}

.file-editor-path {
  flex: 1;
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.save-btn {
  flex-shrink: 0;
  padding: 3px 10px;
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  cursor: pointer;
  transition: background 0.12s ease, border-color 0.12s ease;
}

.save-btn:hover:not(:disabled) {
  background: var(--accent-dim, rgba(80, 150, 179, 0.15));
  border-color: var(--accent-border, rgba(80, 150, 179, 0.4));
  color: var(--accent-primary, #5096b3);
}

.save-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.file-editor-error {
  padding: 12px 16px;
  font-size: 13px;
  color: var(--danger, #e05b5b);
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
}

.editor-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
