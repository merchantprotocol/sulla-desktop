<template>
  <div
    ref="containerRef"
    class="diff-editor-container"
  />
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as monaco from 'monaco-editor';
import { applyMonacoTheme } from './monacoThemeBridge';

const EXT_LANGUAGE_MAP: Record<string, string> = {
  '.ts':        'typescript',
  '.tsx':       'typescript',
  '.js':        'javascript',
  '.jsx':       'javascript',
  '.mjs':       'javascript',
  '.cjs':       'javascript',
  '.json':      'json',
  '.jsonc':     'json',
  '.html':      'html',
  '.htm':       'html',
  '.css':       'css',
  '.scss':      'scss',
  '.less':      'less',
  '.xml':       'xml',
  '.svg':       'xml',
  '.yaml':      'yaml',
  '.yml':       'yaml',
  '.py':        'python',
  '.sh':        'shell',
  '.bash':      'shell',
  '.zsh':       'shell',
  '.sql':       'sql',
  '.go':        'go',
  '.rs':        'rust',
  '.rb':        'ruby',
  '.php':       'php',
  '.java':      'java',
  '.c':         'c',
  '.cpp':       'cpp',
  '.h':         'cpp',
  '.cs':        'csharp',
  '.swift':     'swift',
  '.kt':        'kotlin',
  '.lua':       'lua',
  '.vue':       'html',
  '.md':        'markdown',
  '.txt':       'plaintext',
  '.log':       'plaintext',
  '.gitignore': 'plaintext',
};

function getLanguage(ext: string): string {
  return EXT_LANGUAGE_MAP[ext.toLowerCase()] || 'plaintext';
}

export default defineComponent({
  name: 'DiffEditor',

  props: {
    content:         { type: String, default: '' },
    originalContent: { type: String, default: '' },
    filePath:        { type: String, default: '' },
    fileExt:         { type: String, default: '' },
    isDark:          { type: Boolean, default: false },
    readOnly:        { type: Boolean, default: true },
  },

  emits: ['dirty'],

  setup(props, { emit }) {
    const containerRef = ref<HTMLDivElement | null>(null);
    let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
    let originalModel: monaco.editor.ITextModel | null = null;
    let modifiedModel: monaco.editor.ITextModel | null = null;

    function createEditor() {
      if (!containerRef.value) return;

      const language = getLanguage(props.fileExt);

      console.log('[DiffEditor] creating diff editor', {
        originalLen: props.originalContent?.length,
        modifiedLen: props.content?.length,
        language,
        isDark:      props.isDark,
      });

      originalModel = monaco.editor.createModel(props.originalContent || '', language);
      modifiedModel = monaco.editor.createModel(props.content || '', language);

      // Register the custom theme from CSS variables before creating the editor
      applyMonacoTheme(props.isDark);

      diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
        automaticLayout:        true,
        readOnly:               props.readOnly,
        originalEditable:       false,
        renderSideBySide:       true,
        renderIndicators:       true,
        renderMarginRevertIcon: false,
        renderOverviewRuler:    true,
        minimap:                { enabled: false },
        renderLineHighlight:    'line',
        scrollBeyondLastLine:   false,
        fontSize:               13,
        lineNumbers:            'on',
        padding:                { top: 8 },
        hover:                  { enabled: false },
        diffAlgorithm:          'advanced',
      });

      diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel,
      });

      // Log when diff computation completes
      diffEditor.onDidUpdateDiff(() => {
        const changes = diffEditor!.getLineChanges();
        console.log('[DiffEditor] onDidUpdateDiff - line changes:', changes?.length ?? 0, changes);
      });

      modifiedModel.onDidChangeContent(() => {
        emit('dirty');
      });
    }

    function updateContent() {
      if (!diffEditor) return;
      const language = getLanguage(props.fileExt);

      if (originalModel) {
        monaco.editor.setModelLanguage(originalModel, language);
        originalModel.setValue(props.originalContent || '');
      }
      if (modifiedModel) {
        monaco.editor.setModelLanguage(modifiedModel, language);
        modifiedModel.setValue(props.content || '');
      }
    }

    function updateTheme() {
      // Re-register the custom theme with fresh CSS variable values, then apply
      applyMonacoTheme(props.isDark);
    }

    onMounted(createEditor);

    watch(() => props.content, updateContent);
    watch(() => props.originalContent, updateContent);
    watch(() => props.fileExt, updateContent);
    watch(() => props.isDark, updateTheme);

    onBeforeUnmount(() => {
      if (diffEditor) {
        diffEditor.dispose();
        diffEditor = null;
      }
      if (originalModel) {
        originalModel.dispose();
        originalModel = null;
      }
      if (modifiedModel) {
        modifiedModel.dispose();
        modifiedModel = null;
      }
    });

    const getContent = () => {
      return modifiedModel?.getValue() || props.content;
    };

    return { containerRef, getContent };
  },
});
</script>

<style>
.diff-editor-container {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
</style>
