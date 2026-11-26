// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { FilesBrowserIcons as icons } from './FilesBrowserIcons';

/**
 * Stateless display formatting for the Files browser: sizes, dates, kinds and glyphs.
 * Methods are arrow properties so templates can call them after destructuring.
 */
export class FilesEntryFormatter {
  readonly formatBytes = (bytes:number):string => { if (!bytes) return '0 B'; const units = ['B', 'KB', 'MB', 'GB', 'TB']; const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1); const value = bytes / 1024 ** index; return `${ index < 2 || value >= 100 ? Math.round(value) : Number(value.toFixed(1)) } ${ units[index] }` };

  readonly formatDate = (value:string, detailed = false):string => { if (!value) return '—'; const date = new Date(value); return new Intl.DateTimeFormat(undefined, detailed ? { dateStyle: 'medium', timeStyle: 'short' } : { month: 'short', day: 'numeric' }).format(date) };

  readonly dayLabel = (date:Date):string => { const now = new Date(); if (date.toDateString() === now.toDateString()) return 'Today'; const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1); if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'; return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(date) };

  readonly formatRelative = (value:string):string => { if (!value) return '—'; const date = new Date(value); return `${ this.dayLabel(date) }, ${ new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(date) }` };

  readonly formatShort = (value:string):string => value ? this.dayLabel(new Date(value)) : '—';

  readonly timeAgo = (value:string):string => { const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60_000)); if (minutes < 1) return 'just now'; if (minutes < 60) return `${ minutes } min ago`; const hours = Math.round(minutes / 60); return hours < 24 ? `${ hours } hr ago` : this.formatShort(value) };

  readonly dateBucket = (value:string):string => { const age = Date.now() - Date.parse(value || '0'); return age < 86_400_000 ? 'Today' : age < 604_800_000 ? 'This week' : 'Earlier' };

  readonly fileGlyph = (mime:string, path = ''):{ icon: string; className: string } => {
    const ext = path.split('.').at(-1)?.toLowerCase() ?? '';

    if (mime.startsWith('image/')) return { icon: icons.image, className: 'img' };
    if (mime.startsWith('video/')) return { icon: icons.video, className: 'vid' };
    if (mime.startsWith('audio/')) return { icon: icons.audio, className: 'aud' };
    if (mime === 'application/pdf') return { icon: icons.pdf, className: 'pdf' };
    if (this.isArchive(mime, ext)) return { icon: icons.zip, className: 'zip' };
    if (/json|yaml|javascript|typescript|x-sh|x-python/.test(mime) || ['js', 'ts', 'json', 'yaml', 'yml', 'py', 'sh', 'vue', 'css', 'html', 'htm'].includes(ext)) return { icon: icons.code, className: 'code' };
    if (mime.startsWith('text/') || /document|msword|rtf|opendocument/.test(mime)) return { icon: icons.doc, className: 'doc' };
    return { icon: icons.file, className: 'zip' };
  };

  readonly isArchive = (mime:string, ext:string):boolean => /zip|x-tar|gzip|x-7z|x-rar|compressed/.test(mime) || ['zip', 'tar', 'gz', 'tgz', '7z', 'rar'].includes(ext);

  readonly mimeFromName = (name:string):string => { const ext = name.split('.').at(-1)?.toLowerCase() ?? ''; return ({ png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime', m4a: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', pdf: 'application/pdf', zip: 'application/zip', md: 'text/markdown', html: 'text/html', htm: 'text/html', txt: 'text/plain' } as Record<string, string>)[ext] ?? 'application/octet-stream' };

  readonly kindLabel = (mime:string, path = ''):string => {
    const ext = path.split('.').at(-1)?.toLowerCase() ?? '';

    if (mime === 'inode/directory') return 'Folder';
    if (mime.includes('markdown') || ext === 'md') return 'Markdown';
    if (mime === 'text/html' || ext === 'html' || ext === 'htm') return 'HTML';
    if (mime.startsWith('image/')) return (ext || mime.split('/')[1]).toUpperCase();
    if (mime.startsWith('video/')) return 'Video';
    if (mime.startsWith('audio/')) return 'Audio';
    if (mime === 'application/pdf') return 'PDF';
    if (this.isArchive(mime, ext)) return 'Archive';
    if (mime.startsWith('text/')) return 'Text';
    return ext ? ext.toUpperCase() : 'File';
  };

  readonly initials = (name:string):string => { const words = name.replace(/\(.*?\)/g, '').trim().split(/\s+/).filter(Boolean); return ((words[0]?.[0] ?? '?') + (words.length > 1 ? words[1][0] : '')).toUpperCase() };
}
