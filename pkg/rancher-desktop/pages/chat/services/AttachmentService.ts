/*
  Stateless helpers for turning files into Attachment model objects.
  Drag-drop, paste, file picker all feed through here.
*/

import { humanSize, kindFromName, type Attachment } from '../models/Attachment';
import { newAttachmentId } from '../types/chat';

export const AttachmentService = {
  fromFile(file: File): Attachment {
    const att: Attachment = {
      id:   newAttachmentId(),
      name: file.name,
      size: humanSize(file.size),
      kind: kindFromName(file.name),
      file,
    };
    if (att.kind === 'image') {
      att.source = URL.createObjectURL(file);
    }
    return att;
  },

  fromDescriptor(desc: { name: string; size: string; kind?: Attachment['kind'] }): Attachment {
    return {
      id:   newAttachmentId(),
      name: desc.name,
      size: desc.size,
      kind: desc.kind ?? kindFromName(desc.name),
    };
  },

  fromFilesReference(ref:Attachment['fileRef'] & { name:string }):Attachment {
    if (!ref) throw new Error('Missing Files reference');
    return {
      id: newAttachmentId(), name: ref.name, size: humanSize(ref.size), kind: kindFromName(ref.name), fileRef: {
        fileId: ref.fileId, versionId: ref.versionId, path: ref.path, mime: ref.mime, size: ref.size,
        createdByType: ref.createdByType, createdById: ref.createdById, collectionId: ref.collectionId,
        collectionKind: ref.collectionKind, agentRunId: ref.agentRunId,
      },
    };
  },

  dispose(att: Attachment): void {
    if (att.source?.startsWith('blob:')) URL.revokeObjectURL(att.source);
  },
};
