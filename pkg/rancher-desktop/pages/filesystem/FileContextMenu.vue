<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuRef"
      class="context-menu"
      :class="{ dark: isDark }"
      :style="{ top: posY + 'px', left: posX + 'px' }"
      @contextmenu.prevent
    >
      <!-- New File / New Folder (dirs only) -->
      <template v-if="isDir">
        <button class="context-menu-item" @click="action('new-file')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="12" y1="18" x2="12" y2="12" />
            <line x1="9" y1="15" x2="15" y2="15" />
          </svg>
          <span>New File</span>
        </button>
        <button class="context-menu-item" @click="action('new-folder')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            <line x1="12" y1="11" x2="12" y2="17" />
            <line x1="9" y1="14" x2="15" y2="14" />
          </svg>
          <span>New Folder</span>
        </button>
        <div class="context-menu-sep"></div>
      </template>

      <!-- Cut / Copy / Paste -->
      <button class="context-menu-item" @click="action('cut')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="6" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <line x1="20" y1="4" x2="8.12" y2="15.88" />
          <line x1="14.47" y1="14.48" x2="20" y2="20" />
          <line x1="8.12" y1="8.12" x2="12" y2="12" />
        </svg>
        <span>Cut</span>
        <span class="context-menu-shortcut">⌘X</span>
      </button>
      <button class="context-menu-item" @click="action('copy')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
          <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
        </svg>
        <span>Copy</span>
        <span class="context-menu-shortcut">⌘C</span>
      </button>
      <button v-if="isDir && hasClipboard" class="context-menu-item" @click="action('paste')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
        </svg>
        <span>Paste</span>
        <span class="context-menu-shortcut">⌘V</span>
      </button>
      <div class="context-menu-sep"></div>

      <!-- Rename / Delete -->
      <button class="context-menu-item" @click="action('rename')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
        <span>Rename</span>
      </button>
      <button class="context-menu-item danger" @click="action('delete')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18" />
          <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
          <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
          <line x1="10" y1="11" x2="10" y2="17" />
          <line x1="14" y1="11" x2="14" y2="17" />
        </svg>
        <span>Delete</span>
      </button>
      <div class="context-menu-sep"></div>

      <!-- Copy Path / Copy Relative Path -->
      <button class="context-menu-item" @click="action('copy-path')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        <span>Copy Path</span>
      </button>
      <button class="context-menu-item" @click="action('copy-relative-path')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
          <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
        </svg>
        <span>Copy Relative Path</span>
      </button>
      <div class="context-menu-sep"></div>

      <!-- Reveal / Open -->
      <button class="context-menu-item" @click="action('reveal')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
          <circle cx="12" cy="12" r="3" />
        </svg>
        <span>Reveal in Finder</span>
      </button>
      <button v-if="!isDir" class="context-menu-item" @click="action('open-external')">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
        <span>Open with Default App</span>
      </button>
      <div v-if="!isDir" class="context-menu-sep"></div>

      <!-- Open with... (files only) -->
      <template v-if="!isDir">
        <div class="context-menu-subheader">Open with…</div>
        <button class="context-menu-item" @click="action('open-code-editor')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>
          </svg>
          <span>Code Editor</span>
        </button>
        <button v-if="isMarkdownFile" class="context-menu-item" @click="action('open-markdown-editor')">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
            <polyline points="10 9 9 9 8 9"/>
          </svg>
          <span>Markdown Editor</span>
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted, onBeforeUnmount, nextTick, computed } from 'vue';

export default defineComponent({
  name: 'FileContextMenu',

  props: {
    isDark:       { type: Boolean, default: false },
    hasClipboard: { type: Boolean, default: false },
  },

  emits: ['action'],

  setup(props, { emit, expose }) {
    const visible = ref(false);
    const posX = ref(0);
    const posY = ref(0);
    const isDir = ref(false);
    const fileExt = ref('');
    const menuRef = ref<HTMLElement | null>(null);

    let targetPath = '';

    function show(event: MouseEvent, filePath: string, dir: boolean, ext?: string) {
      targetPath = filePath;
      isDir.value = dir;
      fileExt.value = ext || '';
      posX.value = event.clientX;
      posY.value = event.clientY;
      visible.value = true;

      nextTick(() => {
        if (menuRef.value) {
          const rect = menuRef.value.getBoundingClientRect();
          const vw = window.innerWidth;
          const vh = window.innerHeight;

          if (rect.right > vw) posX.value = vw - rect.width - 4;
          if (rect.bottom > vh) posY.value = vh - rect.height - 4;
        }
      });
    }

    function hide() {
      visible.value = false;
    }

    function action(type: string) {
      emit('action', { type, path: targetPath, isDir: isDir.value });
      hide();
    }

    const isMarkdownFile = computed(() => {
      const ext = fileExt.value.toLowerCase();
      return ['.md', '.markdown', '.mdx'].includes(ext);
    });

    function onClickOutside(e: MouseEvent) {
      if (menuRef.value && !menuRef.value.contains(e.target as Node)) {
        hide();
      }
    }

    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') hide();
    }

    onMounted(() => {
      document.addEventListener('mousedown', onClickOutside);
      document.addEventListener('keydown', onEsc);
    });

    onBeforeUnmount(() => {
      document.removeEventListener('mousedown', onClickOutside);
      document.removeEventListener('keydown', onEsc);
    });

    expose({ show, hide });

    return { visible, posX, posY, isDir, menuRef, action, hasClipboard: props.hasClipboard, isMarkdownFile };
  },
});
</script>

<style scoped>
.context-menu {
  position: fixed;
  z-index: 9999;
  min-width: 180px;
  background: #ffffff;
  border: 1px solid #e2e8f0;
  border-radius: 6px;
  padding: 4px 0;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 3px rgba(0, 0, 0, 0.08);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  font-size: 13px;
}

.context-menu.dark {
  background: #2d2d2d;
  border-color: #404040;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4), 0 1px 3px rgba(0, 0, 0, 0.3);
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 12px;
  border: none;
  background: none;
  color: #333;
  cursor: pointer;
  text-align: left;
  line-height: 1;
}

.context-menu-item:hover {
  background: #f1f5f9;
}

.dark .context-menu-item {
  color: #ccc;
}

.dark .context-menu-item:hover {
  background: #383838;
}

.context-menu-item.danger {
  color: #dc2626;
}

.context-menu-item.danger:hover {
  background: #fef2f2;
}

.dark .context-menu-item.danger {
  color: #f87171;
}

.dark .context-menu-item.danger:hover {
  background: #3b1c1c;
}

.context-menu-shortcut {
  margin-left: auto;
  font-size: 11px;
  color: #999;
  padding-left: 16px;
}

.dark .context-menu-shortcut {
  color: #666;
}

.context-menu-sep {
  height: 1px;
  background: #e2e8f0;
  margin: 4px 0;
}

.dark .context-menu-sep {
  background: #404040;
}

.context-menu-subheader {
  padding: 8px 12px;
  font-weight: bold;
  font-size: 12px;
  color: #666;
}

.dark .context-menu-subheader {
  color: #ccc;
}
</style>
