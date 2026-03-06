<template>
  <div ref="containerRef" class="code-editor-container"></div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import * as monaco from 'monaco-editor';

// Configure Monaco to work in Electron without web workers
(self as any).MonacoEnvironment = {
  getWorker(moduleId: string, label: string) {
    // Return a mock worker that does nothing for all modules
    return {
      postMessage: () => {},
      terminate: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  },
};

// Completely disable web workers and language services that require them
const monacoConfig: Record<string, { enableWorker: boolean }> = {
  // Disable all language features that require web workers
  'json': { enableWorker: false },
  'css': { enableWorker: false },
  'html': { enableWorker: false },
  'typescript': { enableWorker: false },
  'javascript': { enableWorker: false },
};

// Apply the configuration
Object.keys(monacoConfig).forEach(lang => {
  (monaco.languages as any).setLanguageConfiguration(lang, monacoConfig[lang]);
});

const EXT_LANGUAGE_MAP: Record<string, string> = {
  '.ts':         'typescript',
  '.tsx':        'typescript',
  '.js':         'javascript',
  '.jsx':        'javascript',
  '.mjs':        'javascript',
  '.cjs':        'javascript',
  '.json':       'json',
  '.jsonc':      'json',
  '.html':       'html',
  '.htm':        'html',
  '.css':        'css',
  '.scss':       'scss',
  '.less':       'less',
  '.xml':        'xml',
  '.svg':        'xml',
  '.yaml':       'yaml',
  '.yml':        'yaml',
  '.toml':       'ini',
  '.py':         'python',
  '.sh':         'shell',
  '.bash':       'shell',
  '.zsh':        'shell',
  '.sql':        'sql',
  '.graphql':    'graphql',
  '.gql':        'graphql',
  '.dockerfile': 'dockerfile',
  '.go':         'go',
  '.rs':         'rust',
  '.rb':         'ruby',
  '.php':        'php',
  '.java':       'java',
  '.c':          'c',
  '.cpp':        'cpp',
  '.h':          'cpp',
  '.cs':         'csharp',
  '.swift':      'swift',
  '.kt':         'kotlin',
  '.lua':        'lua',
  '.r':          'r',
  '.ini':        'ini',
  '.conf':       'ini',
  '.cfg':        'ini',
  '.env':        'ini',
  '.txt':        'plaintext',
  '.log':        'plaintext',
  '.gitignore':  'plaintext',
};

const FILENAME_LANGUAGE_MAP: Record<string, string> = {
  'dockerfile':  'dockerfile',
  'makefile':    'shell',
  'justfile':    'shell',
  'rakefile':    'ruby',
  'gemfile':     'ruby',
  '.editorconfig': 'ini',
};

function getLanguageFromFile(ext: string, filePath?: string): string {
  if (filePath) {
    const basename = filePath.split('/').pop()?.toLowerCase() || '';
    if (FILENAME_LANGUAGE_MAP[basename]) return FILENAME_LANGUAGE_MAP[basename];
  }
  return EXT_LANGUAGE_MAP[ext.toLowerCase()] || 'plaintext';
}

export default defineComponent({
  name: 'CodeEditor',

  props: {
    content:  { type: String, default: '' },
    filePath: { type: String, default: '' },
    fileExt:  { type: String, default: '' },
    isDark:   { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
  },

  emits: ['dirty'],

  setup(props, { emit }) {
    const containerRef = ref<HTMLDivElement | null>(null);
    let editor: monaco.editor.IStandaloneCodeEditor | null = null;

    function createEditor() {
      if (!containerRef.value) {
        console.warn('CodeEditor: Container ref not available');
        return;
      }

      try {
        // Additional worker disabling right before editor creation
        (self as any).MonacoEnvironment = {
          getWorker(moduleId: string, label: string) {
            return {
              postMessage: () => {},
              terminate: () => {},
              addEventListener: () => {},
              removeEventListener: () => {},
              onmessage: null,
            };
          },
        };

        const language = getLanguageFromFile(props.fileExt, props.filePath);

        console.log('CodeEditor: Creating editor with content length:', props.content?.length);
        console.log('CodeEditor: Editor language:', language);
        console.log('CodeEditor: Initial content preview:', props.content?.substring(0, 100));

        editor = monaco.editor.create(containerRef.value, {
          value:       props.content || '',
          language,
          theme:       props.isDark ? 'vs-dark' : 'vs',
          readOnly:    props.readOnly,
          automaticLayout: true,
          minimap:     { enabled: false }, // Disable minimap to reduce issues
          scrollBeyondLastLine: false,
          fontSize:    13,
          lineNumbers: 'on',
          renderLineHighlight: 'line',
          wordWrap:    'on',
          padding:     { top: 8 },
          // Disable features that require web workers
          hover:       { enabled: false },
          parameterHints: { enabled: false },
          // Disable language services that use workers
          quickSuggestions: { other: false, comments: false, strings: false },
          suggestOnTriggerCharacters: false,
          acceptSuggestionOnEnter: 'off',
          tabCompletion: 'off',
          wordBasedSuggestions: 'off',
        });

        // Check content immediately after creation and force render
        setTimeout(() => {
          if (editor) {
            const model = editor.getModel();
            if (model) {
              console.log('CodeEditor: After creation - model value length:', model.getValue().length);
              console.log('CodeEditor: After creation - model value preview:', model.getValue().substring(0, 100));
              
              // Force Monaco to render the content
              editor.layout();
              editor.revealLine(1);
              editor.focus();
              
              // Force a content refresh
              setTimeout(() => {
                if (editor) {
                  editor.layout();
                  const refreshedModel = editor.getModel();
                  if (refreshedModel) {
                    console.log('CodeEditor: After refresh - model value length:', refreshedModel.getValue().length);
                  }
                }
              }, 200);
            }
          }
        }, 100);

        // Listen for content changes to mark as dirty
        editor.onDidChangeModelContent(() => {
          // Emit dirty event to parent component
          emit('dirty');
        });

        console.log('CodeEditor: Editor created successfully');
      } catch (error) {
        console.error('CodeEditor: Failed to create editor', error);
      }
    }

    function updateContent() {
      if (editor) {
        console.log('CodeEditor: Updating content, length:', props.content?.length);
        const language = getLanguageFromFile(props.fileExt, props.filePath);
        const model = editor.getModel();
        if (model) {
          console.log('CodeEditor: Setting model language to:', language);
          monaco.editor.setModelLanguage(model, language);
          console.log('CodeEditor: Setting model value, current value length:', model.getValue().length);
          model.setValue(props.content || '');
          console.log('CodeEditor: Model value set, new length:', model.getValue().length);
          
          // Force display update
          editor.layout();
          editor.revealLine(1);
          
          // Additional force - recreate model if needed
          setTimeout(() => {
            if (editor && model.getValue().length === 0 && props.content?.length > 0) {
              console.log('CodeEditor: Model still empty, forcing content...');
              const newModel = monaco.editor.createModel(props.content || '', language);
              editor.setModel(newModel);
              editor.layout();
              editor.revealLine(1);
            }
          }, 100);
        } else {
          console.error('CodeEditor: No model found on editor');
        }
      } else {
        console.warn('CodeEditor: Editor not available for content update');
      }
    }

    function updateReadOnly() {
      if (editor) {
        editor.updateOptions({ readOnly: props.readOnly });
      }
    }

    function updateTheme() {
      if (editor) {
        monaco.editor.setTheme(props.isDark ? 'vs-dark' : 'vs');
      }
    }

    onMounted(createEditor);

    watch(() => props.content, updateContent);
    watch(() => props.fileExt, updateContent);
    watch(() => props.isDark, updateTheme);
    watch(() => props.readOnly, updateReadOnly);

    onBeforeUnmount(() => {
      if (editor) {
        editor.dispose();
        editor = null;
      }
    });

    // Expose method to get current editor content
    const getContent = () => {
      return editor?.getValue() || props.content;
    };

    return {
      containerRef,
      getContent,
    };
  },
});
</script>

<style scoped>
.code-editor-container {
  width: 100%;
  height: 100%;
}
</style>
