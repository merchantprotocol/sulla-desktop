/**
 * Mobile relay turns carry either a string or Anthropic-style content parts:
 *   { type: 'text', text }
 *   { type: 'image', source: { type: 'base64', media_type, data } }
 *   { type: 'document', source: { type: 'base64', media_type, data }, title }
 *
 * The relay used to call `.trim()` on that array, which threw inside the
 * message handler: the turn was never scribed or acked, the phone retried it
 * forever, and the user saw an endless "thinking" spinner for every photo or
 * document they attached.
 *
 * This module turns a mobile turn into what the agent pipeline accepts:
 * plain text for the prompt and the scribe, base64 image blocks for
 * `metadata.attachments` (BackendGraphWebSocketService forwards those to the
 * model), and files on disk so tools can open documents and images by path.
 */

import fs from 'node:fs';
import path from 'node:path';

export interface MobileImageBlock {
  type:   'image';
  source: { type: 'base64'; media_type: string; data: string };
}

export interface MobileAttachmentFile {
  kind:      'image' | 'document';
  name:      string;
  mediaType: string;
  data:      string;
}

export interface NormalizedMobileTurn {
  /** What the human typed. Used for the scribed transcript row. */
  text:   string;
  images: MobileImageBlock[];
  files:  MobileAttachmentFile[];
}

const EXTENSIONS: Record<string, string> = {
  'image/jpeg':      'jpg',
  'image/png':       'png',
  'image/gif':       'gif',
  'image/webp':      'webp',
  'image/heic':      'heic',
  'application/pdf': 'pdf',
  'text/plain':      'txt',
  'text/csv':        'csv',
  'text/markdown':   'md',
};

export function normalizeMobileContent(content: unknown): NormalizedMobileTurn {
  if (typeof content === 'string') return { text: content.trim(), images: [], files: [] };
  if (!Array.isArray(content)) return { text: '', images: [], files: [] };

  const texts: string[] = [];
  const images: MobileImageBlock[] = [];
  const files: MobileAttachmentFile[] = [];
  let n = 0;

  for (const part of content) {
    if (!part || typeof part !== 'object') continue;
    if (part.type === 'text' && typeof part.text === 'string') {
      texts.push(part.text);
      continue;
    }
    const source = part.source;
    if (source?.type !== 'base64' || typeof source.data !== 'string' || !source.data) continue;
    const mediaType = typeof source.media_type === 'string' ? source.media_type : 'application/octet-stream';
    n += 1;
    if (part.type === 'image') {
      images.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: source.data } });
      files.push({ kind: 'image', name: `photo-${ n }.${ EXTENSIONS[mediaType] || 'img' }`, mediaType, data: source.data });
    } else if (part.type === 'document') {
      const title = typeof part.title === 'string' && part.title.trim() ? part.title.trim() : `document-${ n }.${ EXTENSIONS[mediaType] || 'bin' }`;
      files.push({ kind: 'document', name: title, mediaType, data: source.data });
    }
  }

  return { text: texts.join('\n').trim(), images, files };
}

/** File name that cannot escape the target directory or hide as a dotfile. */
export function safeFileName(name: string): string {
  const base = path.basename(String(name || '')).replace(/[^\w.\- ]+/g, '_').replace(/^\.+/, '').trim();
  return (base || 'attachment').slice(0, 120);
}

/**
 * Write attachments under `<dir>/<conversationId>/<messageId>-<name>` and
 * return the absolute paths in input order.
 */
export async function persistMobileAttachments(
  dir: string,
  conversationId: string,
  messageId: string,
  files: MobileAttachmentFile[],
): Promise<string[]> {
  if (!files.length) return [];
  const target = path.join(dir, safeFileName(conversationId));
  await fs.promises.mkdir(target, { recursive: true, mode: 0o700 });
  const out: string[] = [];
  for (const file of files) {
    const filePath = path.join(target, `${ safeFileName(messageId) }-${ safeFileName(file.name) }`);
    await fs.promises.writeFile(filePath, Buffer.from(file.data, 'base64'), { mode: 0o600 });
    out.push(filePath);
  }
  return out;
}

/** Prompt text for the agent: what was typed plus where the files are. */
export function describeTurnForAgent(turn: NormalizedMobileTurn, savedPaths: string[]): string {
  if (!turn.files.length) return turn.text;
  const lines = turn.files.map((f, i) => {
    const where = savedPaths[i] ? ` — saved at ${ savedPaths[i] }` : '';
    return `- ${ f.kind === 'image' ? 'Photo' : 'Document' } "${ f.name }" (${ f.mediaType })${ where }`;
  });
  const header = turn.text || 'The user sent attachments from Sulla Mobile without a message.';
  return `${ header }\n\n[Attached from Sulla Mobile]\n${ lines.join('\n') }`;
}

/** Transcript text for the scribed user row (mirrors what the phone shows). */
export function transcriptText(turn: NormalizedMobileTurn): string {
  if (turn.text) return turn.text;
  if (!turn.files.length) return '';
  return `📎 ${ turn.files.map(f => f.name).join(', ') }`;
}
