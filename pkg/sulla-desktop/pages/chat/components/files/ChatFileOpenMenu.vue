<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
<template>
  <div ref="menu" class="chat-file-open-menu" popover="manual" aria-label="Open file" @click.stop @contextmenu.prevent>
    <button type="button" autofocus @click="choose('sulla')">Open in Sulla</button>
    <button type="button" @click="choose('default')">Open with Default App</button>
    <button v-if="canChooseApp" type="button" @click="choose('choose')">Choose App…</button>
  </div>
</template>

<script lang="ts">
let closeActiveFileMenu: (() => void) | undefined;
</script>

<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

import { openChatFile } from '../../services/openChatFile';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

interface OpenableFile { fileId: string; versionId?: string }

const emit = defineEmits<{ error:[message:string] }>();
const menu = ref<HTMLElement>();
const canChooseApp = /Mac/i.test(navigator.platform);
let file: OpenableFile | undefined;
let opener: HTMLElement | null = null;

function close():void {
  if (closeActiveFileMenu !== close) return;
  closeActiveFileMenu = undefined;
  document.removeEventListener('pointerdown', onPointerDown, true);
  document.removeEventListener('contextmenu', dismissOutside, true);
  document.removeEventListener('keydown', onKeyDown, true);
  menu.value?.hidePopover();
}

function dismissOutside(event: Event):void {
  if (!menu.value?.contains(event.target as Node)) close();
}

function onPointerDown(event: PointerEvent):void {
  // The secondary-button gesture opens the menu; its release must leave it open.
  if (event.button === 0) dismissOutside(event);
}

function onKeyDown(event: KeyboardEvent):void {
  if (event.key !== 'Escape') return;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
  opener?.focus({ preventScroll: true });
}

function show(event: MouseEvent, reference: OpenableFile):void {
  const element = menu.value;
  if (!element) return;
  closeActiveFileMenu?.();
  file = reference;
  opener = event.currentTarget as HTMLElement;
  const anchor = opener.getBoundingClientRect();
  closeActiveFileMenu = close;
  element.showPopover();
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('contextmenu', dismissOutside, true);
  document.addEventListener('keydown', onKeyDown, true);
  const x = event.clientX || anchor.left;
  const y = event.clientY || anchor.bottom;
  element.style.left = `${ Math.max(0, Math.min(x, innerWidth - element.offsetWidth - 4)) }px`;
  element.style.top = `${ Math.max(0, Math.min(y, innerHeight - element.offsetHeight - 4)) }px`;
}

async function choose(destination: 'sulla' | 'default' | 'choose'):Promise<void> {
  const selected = file;
  close();
  if (!selected) return;
  emit('error', '');
  try {
    if (destination === 'sulla') await openChatFile(selected);
    else await ipcRenderer.invoke(destination === 'default' ? 'files-ui:open-default' : 'files-ui:open-with', {
      fileId: selected.fileId, versionId: selected.versionId || undefined,
    });
  } catch (cause) {
    emit('error', cause instanceof Error ? cause.message : 'This file could not be opened.');
  }
}

onBeforeUnmount(close);
defineExpose({ show });
</script>

<style scoped>
.chat-file-open-menu {
  position: fixed;
  inset: auto;
  margin: 0;
  padding: 4px;
  border: 1px solid var(--border-default);
  border-radius: 8px;
  background: var(--bg-surface);
  color: var(--text-primary);
  box-shadow: 0 6px 18px var(--bg-overlay);
}
.chat-file-open-menu button {
  display: block;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  text-align: left;
  font: 12px var(--font-body);
  cursor: pointer;
}
.chat-file-open-menu button:hover,
.chat-file-open-menu button:focus-visible { background: var(--bg-hover); }
</style>
