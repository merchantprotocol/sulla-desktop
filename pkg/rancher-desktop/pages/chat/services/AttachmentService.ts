/*
  Stateless helpers for turning files into Attachment model objects.
  Drag-drop, paste, file picker all feed through here.
*/

import { humanSize, kindFromName, type Attachment } from '../models/Attachment';
import { newAttachmentId } from '../types/chat';

type FilesReferenceInput = Omit<NonNullable<Attachment['fileRef']>, 'versionId'> & { versionId?:string; name:string };

function assertSafeFilesPath(value:string):string {
  const normalized = value.trim();
  const parts = normalized.split('/');
  if (!normalized || normalized.includes('\\') || normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized) || parts.some(part => !part || part === '.' || part === '..' || part.includes('\0'))) {
    throw new Error('Files returned an invalid attachment path.');
  }
  return normalized;
}

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

  fromFilesReference(ref:FilesReferenceInput):Attachment {
    if (!ref) throw new Error('Missing Files reference');
    const fileId = String(ref.fileId ?? '').trim();
    if (!fileId || !/^[a-zA-Z0-9_-]+$/.test(fileId)) throw new Error('Files returned an invalid file identity.');
    const versionId = ref.versionId === undefined ? undefined : String(ref.versionId).trim();
    if (versionId && !/^[a-zA-Z0-9_-]+$/.test(versionId)) throw new Error('Files returned an invalid version identity.');
    const safePath = assertSafeFilesPath(String(ref.path ?? ''));
    const name = safePath.split('/').at(-1)!;
    const size = Number(ref.size);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Files returned an invalid attachment size.');
    const mime = String(ref.mime || 'application/octet-stream').trim().slice(0, 255);
    return {
      id: newAttachmentId(), name, size: humanSize(size), kind: kindFromName(name), fileRef: {
        fileId, versionId: versionId ?? '', path: safePath, mime, size,
        createdByType: ref.createdByType, createdById: ref.createdById, collectionId: ref.collectionId,
        collectionKind: ref.collectionKind, agentRunId: ref.agentRunId,
      },
    };
  },

  dispose(att: Attachment): void {
    if (att.source?.startsWith('blob:')) URL.revokeObjectURL(att.source);
  },
};
