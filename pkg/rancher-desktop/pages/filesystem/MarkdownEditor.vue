<template>
  <div ref="containerRef" class="markdown-editor-container" :class="{ dark: isDark }"></div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, watch } from 'vue';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BlockNoteEditor } from '@blocknote/core';
import { BlockNoteViewRaw } from '@blocknote/react';
import '@blocknote/core/style.css';
import '@blocknote/react/style.css';

function BlockNoteWrapper(props: { content: string; darkMode: boolean }) {
  const [editor] = React.useState(() => {
    return BlockNoteEditor.create();
  });

  React.useEffect(() => {
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

  return React.createElement(BlockNoteViewRaw as any, {
    editor,
    editable: false,
    theme: props.darkMode ? 'dark' : 'light',
  });
}

export default defineComponent({
  name: 'MarkdownEditor',

  props: {
    content: { type: String, default: '' },
    filePath: { type: String, default: '' },
    isDark: { type: Boolean, default: false },
  },

  setup(props) {
    const containerRef = ref<HTMLDivElement | null>(null);
    let reactRoot: Root | null = null;

    function renderReact() {
      if (!containerRef.value) return;

      if (!reactRoot) {
        reactRoot = createRoot(containerRef.value);
      }

      reactRoot.render(
        React.createElement(BlockNoteWrapper, {
          content: props.content,
          darkMode: props.isDark,
        }),
      );
    }

    onMounted(renderReact);

    watch(() => props.content, renderReact);
    watch(() => props.isDark, renderReact);

    onBeforeUnmount(() => {
      if (reactRoot) {
        reactRoot.unmount();
        reactRoot = null;
      }
    });

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
}

.markdown-editor-container :deep(.bn-editor) {
  padding: 16px 24px;
}
</style>
