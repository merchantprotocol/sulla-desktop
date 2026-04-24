/*
  Window-level drag-and-drop for files. Shows an overlay while files
  are being dragged over; on drop, pipes Files through AttachmentService
  into the controller's staging tray.
*/

import { onMounted, onBeforeUnmount, ref } from 'vue';

import { AttachmentService } from '../services/AttachmentService';
import { useChatController } from '../controller/useChatController';
import type { ChatController } from '../controller/ChatController';

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
  function onDrop(e: DragEvent) {
    if (!e.dataTransfer || !e.dataTransfer.files || e.dataTransfer.files.length === 0) return;
    e.preventDefault();
    depth = 0;
    active.value = false;
    for (const file of Array.from(e.dataTransfer.files)) {
      const att = AttachmentService.fromFile(file);
      controller?.stageAttachment(att);
    }
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
