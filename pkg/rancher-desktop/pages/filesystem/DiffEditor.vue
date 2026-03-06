<template>
  <div ref="containerRef" class="diff-editor-container"></div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as monaco from 'monaco-editor';

const EXT_LANGUAGE_MAP: Record<string, string> = {
  '.ts': 'typescript', '.tsx': 'typescript',
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.json': 'json', '.jsonc': 'json',
  '.html': 'html', '.htm': 'html',
  '.css': 'css', '.scss': 'scss', '.less': 'less',
  '.xml': 'xml', '.svg': 'xml',
  '.yaml': 'yaml', '.yml': 'yaml',
  '.py': 'python', '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell',
  '.sql': 'sql', '.go': 'go', '.rs': 'rust', '.rb': 'ruby',
  '.php': 'php', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.h': 'cpp',
  '.cs': 'csharp', '.swift': 'swift', '.kt': 'kotlin', '.lua': 'lua',
  '.vue': 'html', '.md': 'markdown',
  '.txt': 'plaintext', '.log': 'plaintext', '.gitignore': 'plaintext',
};

function getLanguage(ext: string): string {
  return EXT_LANGUAGE_MAP[ext.toLowerCase()] || 'plaintext';
}

export default defineComponent({
  name: 'DiffEditor',

  props: {
    content:         { type: String, default: '' },   // modified (current working copy)
    originalContent: { type: String, default: '' },   // original (HEAD version)
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

      originalModel = monaco.editor.createModel(props.originalContent || '', language);
      modifiedModel = monaco.editor.createModel(props.content || '', language);

      // Set theme before creating the editor
      monaco.editor.setTheme(props.isDark ? 'vs-dark' : 'vs');

      diffEditor = monaco.editor.createDiffEditor(containerRef.value, {
        automaticLayout:     true,
        readOnly:            props.readOnly,
        originalEditable:    false,
        renderSideBySide:    true,
        minimap:             { enabled: false },
        scrollBeyondLastLine: false,
        fontSize:            13,
        lineNumbers:         'on',
        renderLineHighlight: 'line',
        padding:             { top: 8 },
        hover:               { enabled: false },
      });

      diffEditor.setModel({
        original: originalModel,
        modified: modifiedModel,
      });

      // Listen for changes in the modified editor
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
      monaco.editor.setTheme(props.isDark ? 'vs-dark' : 'vs');
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

<style scoped>
.diff-editor-container {
  width: 100%;
  height: 100%;
}
</style>
