<template>
  <div ref="containerRef" class="markdown-editor-container" :class="{ dark: isDark }"></div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BlockNoteEditor } from '@blocknote/core';
import { BlockNoteView } from '@blocknote/mantine';
import '@blocknote/core/style.css';
import '@blocknote/mantine/style.css';

// Shared editor ref so the Vue layer can call getMarkdown()
let _sharedEditor: BlockNoteEditor | null = null;

function BlockNoteWrapper(props: { content: string; darkMode: boolean; onDirty: () => void; readOnly: boolean }) {
  const [editor] = React.useState(() => {
    const ed = BlockNoteEditor.create();
    _sharedEditor = ed;
    return ed;
  });

  // Keep shared ref up to date (React strict mode may re-create)
  React.useEffect(() => {
    _sharedEditor = editor;
    return () => { _sharedEditor = null; };
  }, [editor]);

  const contentRef = React.useRef(props.content);

  React.useEffect(() => {
    // Only load content when the prop actually changes (new file opened)
    if (props.content === contentRef.current && editor.document.length > 1) return;
    contentRef.current = props.content;

    if (props.content) {
      const loadContent = async () => {
        try {
          const blocks = await editor.tryParseMarkdownToBlocks(props.content);
          editor.replaceBlocks(editor.document, blocks);
        } catch {
          // fallback: just show raw text
        }
      };
      loadContent();
    }
  }, [props.content]);

  return React.createElement(BlockNoteView as any, {
    editor,
    editable: !props.readOnly,
    theme: props.darkMode ? 'dark' : 'light',
    onChange: () => { props.onDirty(); },
  });
}

export default defineComponent({
  name: 'MarkdownEditor',

  props: {
    content:  { type: String, default: '' },
    filePath: { type: String, default: '' },
    isDark:   { type: Boolean, default: false },
    readOnly: { type: Boolean, default: false },
  },

  emits: ['dirty'],

  setup(props, { emit, expose }) {
    const containerRef = ref<HTMLDivElement | null>(null);
    let reactRoot: Root | null = null;

    function renderReact() {
      if (!containerRef.value) return;

      if (!reactRoot) {
        reactRoot = createRoot(containerRef.value);
      }

      reactRoot.render(
        React.createElement(BlockNoteWrapper, {
          content:  props.content,
          darkMode: props.isDark,
          readOnly: props.readOnly,
          onDirty:  () => emit('dirty'),
        }),
      );
    }

    async function getMarkdown(): Promise<string> {
      if (!_sharedEditor) return props.content;
      try {
        return await _sharedEditor.blocksToMarkdownLossy(_sharedEditor.document);
      } catch {
        return props.content;
      }
    }

    onMounted(renderReact);

    watch(() => props.content, renderReact);
    watch(() => props.isDark, renderReact);
    watch(() => props.readOnly, renderReact);

    onBeforeUnmount(() => {
      if (reactRoot) {
        reactRoot.unmount();
        reactRoot = null;
      }
    });

    expose({ getMarkdown });

    return { containerRef };
  },
});
</script>

<style scoped>
.markdown-editor-container {
  width: 100%;
  height: 100%;
  overflow: auto;
}

.markdown-editor-container :deep(.bn-container) {
  height: 100%;
  border-radius: 0;
}

.markdown-editor-container :deep(.bn-container [class*="root"]) {
  border-radius: 0;
}

.dark.markdown-editor-container {
  background: #1e1e1e;
}

.dark.markdown-editor-container :deep(.bn-container) {
  background: #1e1e1e;
}

.markdown-editor-container :deep(.bn-editor) {
  padding: 16px 24px;
}

/* Ensure BlockNote menus (side menu, slash menu, etc.) are not clipped */
.markdown-editor-container :deep(.bn-side-menu),
.markdown-editor-container :deep(.mantine-Popover-dropdown),
.markdown-editor-container :deep(.mantine-Menu-dropdown) {
  z-index: 1000;
}
</style>
