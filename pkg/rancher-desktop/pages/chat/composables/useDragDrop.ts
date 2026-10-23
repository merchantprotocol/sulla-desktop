/*
  Window-level drag-and-drop for files. Shows an overlay while files
  are being dragged over; on drop, pipes Files through AttachmentService
  into the controller's staging tray.
*/

import { onMounted, onBeforeUnmount, ref } from 'vue';
import { webUtils } from 'electron';

import { AttachmentService } from '../services/AttachmentService';
import { useChatController } from '../controller/useChatController';
import type { ChatController } from '../controller/ChatController';
import { ipcRenderer } from '@pkg/utils/ipcRenderer';

export function useDragDrop(controllerOverride?: ChatController) {
  const active = ref(false);
  let depth = 0;

  // Prefer an explicit controller (for the component that also provides it,
  // since Vue doesn't let a component inject its own provide). Fall back
  // to inject for descendants.
  let controller: ChatController | undefined = controllerOverride;
  if (!controller) {
    try { controller = useChatController(); } catch { /* fine in tests */ }
  }

  function hasFiles(e: DragEvent): boolean {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }

  function onEnter(e: DragEvent) {
    if (!hasFiles(e)) return;
    depth++;
    active.value = true;
  }
  function onOver(e: DragEvent) {
    if (hasFiles(e)) e.preventDefault();
  }
  function onLeave() {
    depth = Math.max(0, depth - 1);
    if (depth === 0) active.value = false;
  }
  async function onDrop(e: DragEvent) {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    depth = 0;
    active.value = false;
    const paths = Array.from(e.dataTransfer.files, file => webUtils.getPathForFile(file));
    if (paths.some(value => !value)) throw new Error('Sulla could not read one or more dropped files.');
    const result = await ipcRenderer.invoke('files-ui:import-path-references', { paths }) as any[] | { references:any[]; error:string };
    const references = Array.isArray(result) ? result : result.references;
    for (const reference of references) {
      controller?.stageAttachment(AttachmentService.fromFilesReference(reference));
    }
    if (!Array.isArray(result) && result.error) console.warn('[Chat] Some dropped files could not be imported:', result.error);
  }

  onMounted(() => {
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragover',  onOver);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop',      onDrop);
  });
  onBeforeUnmount(() => {
    document.removeEventListener('dragenter', onEnter);
    document.removeEventListener('dragover',  onOver);
    document.removeEventListener('dragleave', onLeave);
    document.removeEventListener('drop',      onDrop);
  });

  return { active };
}
