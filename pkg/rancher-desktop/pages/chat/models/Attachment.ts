import type { AttachmentId } from '../types/chat';

export type AttachmentKind = 'image' | 'json' | 'ts' | 'md' | 'log' | 'file';

export interface Attachment {
  id:   AttachmentId;
  name: string;
  size: string;        // humanized "48 KB"
  kind: AttachmentKind;
  /** Optional — data URL for images, a path handle, or a blob URL */
  source?: string;
  /** Original File object if the attachment came from drag-drop */
  file?:   File;
  /** Durable Files identity. Unlike a File/blob URL this survives chat reloads. */
  fileRef?: {
    fileId: string; versionId: string; path: string; mime: string; size: number;
    createdByType?: string; createdById?: string; collectionId?: string; collectionKind?: string; agentRunId?: string;
  };
}

export function kindFromName(name: string): AttachmentKind {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
  if (['ts', 'js', 'tsx', 'jsx'].includes(ext)) return 'ts';
  if (['md', 'markdown'].includes(ext)) return 'md';
  if (['log', 'txt'].includes(ext)) return 'log';
  if (ext === 'json') return 'json';
  return 'file';
}

export function humanSize(bytes: number): string {
  if (bytes < 1024)          return `${ bytes } B`;
  if (bytes < 1024 * 1024)   return `${ Math.round(bytes / 1024) } KB`;
  return `${ (bytes / 1024 / 1024).toFixed(1) } MB`;
}
