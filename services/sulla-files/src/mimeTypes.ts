import { extname } from 'node:path';

const GENERIC = 'application/octet-stream';
const BY_EXTENSION: Record<string, string> = {
    '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
    '.js': 'text/javascript', '.jsx': 'text/javascript', '.mjs': 'text/javascript', '.cjs': 'text/javascript', '.ts': 'text/typescript', '.tsx': 'text/typescript',
    '.css': 'text/css', '.html': 'text/html', '.htm': 'text/html', '.vue': 'text/plain', '.svelte': 'text/plain', '.py': 'text/x-python', '.rb': 'text/x-ruby', '.go': 'text/x-go', '.rs': 'text/x-rust',
    '.java': 'text/x-java-source', '.c': 'text/x-c', '.h': 'text/x-c', '.cc': 'text/x-c++', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++', '.swift': 'text/x-swift', '.kt': 'text/x-kotlin',
    '.sh': 'text/x-shellscript', '.sql': 'text/x-sql', '.toml': 'text/x-toml', '.json': 'application/json', '.yaml': 'application/yaml', '.yml': 'application/yaml', '.xml': 'application/xml',
    '.pdf': 'application/pdf', '.doc': 'application/msword', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xls': 'application/vnd.ms-excel', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
    '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.weba': 'audio/webm',
    '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  };

/** Content type implied by a file name; octet-stream when unknown. */
export function mimeForPath(path:string):string {
  return BY_EXTENSION[extname(path).toLowerCase()] ?? GENERIC;
}

/**
 * Pick the stored content type for a write. Writers that don't know the type
 * (the Files mount always sends octet-stream; empty creates default to
 * text/plain) must not hide an image or video from previews, so a generic or
 * text declaration on a known non-text extension yields the extension's type.
 */
export function resolveMime(path:string, declared?:string|null):string {
  const fromName = mimeForPath(path);
  const value = (declared ?? '').split(';')[0].trim().toLowerCase();
  if (!value || value === GENERIC) return fromName;
  if (value === 'text/plain' && fromName !== GENERIC && !fromName.startsWith('text/')) return fromName;
  return declared!;
}
