<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="tab-context-menu"
      :class="{ dark: isDark }"
      :style="{ top: y + 'px', left: x + 'px' }"
      @contextmenu.prevent
    >
      <!-- View in Finder -->
      <button class="context-menu-item" @click="handleViewInFinder">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>View in Finder</span>
      </button>

      <!-- Open with... -->
      <div class="context-menu-sep"></div>
      <div class="context-menu-subheader">Open with…</div>
      <button class="context-menu-item" @click="handleOpenWithEditor('code')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
        </svg>
        <span>Code Editor</span>
      </button>
      <button
        v-if="tab && MARKDOWN_EXTS.has(tab.ext.toLowerCase())"
        class="context-menu-item"
        @click="handleOpenWithEditor('preview')"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>Preview</span>
      </button>

      <!-- Tab actions -->
      <div class="context-menu-sep"></div>
      <button class="context-menu-item" @click="handleSaveTab">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
          <polyline points="17,21 17,13 7,13 7,21"/>
          <polyline points="7,3 7,8 15,8"/>
        </svg>
        <span>Save</span>
      </button>
      <button class="context-menu-item" @click="handleCloseTab">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
        <span>Close Tab</span>
      </button>
      <button class="context-menu-item" @click="handleCloseOthers">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
        <span>Close Others</span>
      </button>
      <button class="context-menu-item" @click="handleCloseAll">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 6L6 18M6 6l12 12"/>
        </svg>
        <span>Close All</span>
      </button>
    </div>
  </Teleport>
</template>

<script lang="ts">
import { defineComponent, ref, watch } from 'vue';

const MARKDOWN_EXTS = new Set(['.md', '.markdown', '.mdx']);

export interface TabState {
  path: string;
  name: string;
  ext: string;
  content: string;
  loading: boolean;
  error: string;
  dirty: boolean;
  editorType?: 'code' | 'preview' | 'webview' | 'terminal' | 'diff' | 'agent-form';
  originalContent?: string;
}

export default defineComponent({
  name: 'TabContextMenu',

  props: {
    visible: {
      type: Boolean,
      default: false
    },
    x: {
      type: Number,
      default: 0
    },
    y: {
      type: Number,
      default: 0
    },
    tab: {
      type: Object as () => TabState | null,
      default: null
    },
    isDark: {
      type: Boolean,
      default: false
    }
  },

  emits: [
    'view-in-finder',
    'open-with-editor',
    'save-tab',
    'close-tab',
    'close-others',
    'close-all'
  ],

  setup(props, { emit }) {
    const menuRef = ref<HTMLElement>();

    const handleViewInFinder = () => {
      if (props.tab) {
        emit('view-in-finder', props.tab);
      }
    };

    const handleOpenWithEditor = (editorType: 'code' | 'preview') => {
      if (props.tab) {
        emit('open-with-editor', props.tab, editorType);
      }
    };

    const handleSaveTab = () => {
      if (props.tab) {
        emit('save-tab', props.tab);
      }
    };

    const handleCloseTab = () => {
      if (props.tab) {
        emit('close-tab', props.tab);
      }
    };

    const handleCloseOthers = () => {
      if (props.tab) {
        emit('close-others', props.tab);
      }
    };

    const handleCloseAll = () => {
      emit('close-all');
    };

    return {
      menuRef,
      MARKDOWN_EXTS,
      handleViewInFinder,
      handleOpenWithEditor,
      handleSaveTab,
      handleCloseTab,
      handleCloseOthers,
      handleCloseAll
    };
  }
});
</script>

<style scoped>
.tab-context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: var(--bg-surface);
  border: 1px solid var(--bg-surface-hover);
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-family: var(--font-sans);
  font-size: var(--fs-code);
}

.tab-context-menu .context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: var(--text-primary);
  cursor: pointer;
  text-align: left;
  line-height: 1;
}

.tab-context-menu .context-menu-item:hover {
  background: var(--bg-hover);
}

.tab-context-menu .context-menu-sep {
  height: 1px;
  background: var(--bg-surface-hover);
  margin: 4px 0;
}

.tab-context-menu .context-menu-subheader {
  padding: 8px 12px;
  font-weight: var(--weight-semibold);
  font-size: var(--fs-code);
  color: var(--text-secondary);
}

.tab-context-menu .context-menu-shortcut {
  margin-left: auto;
  font-size: var(--fs-body-sm);
  color: var(--text-muted);
  padding-left: 16px;
}
</style>
