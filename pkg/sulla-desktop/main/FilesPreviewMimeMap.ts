// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

export class FilesPreviewMimeMap {
  private readonly types:Record<string,string> = {
    html:'text/html; charset=utf-8', htm:'text/html; charset=utf-8', css:'text/css; charset=utf-8', js:'text/javascript; charset=utf-8', mjs:'text/javascript; charset=utf-8',
    json:'application/json; charset=utf-8', txt:'text/plain; charset=utf-8', svg:'image/svg+xml', png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg', gif:'image/gif', webp:'image/webp', avif:'image/avif', ico:'image/x-icon',
    woff:'font/woff', woff2:'font/woff2', ttf:'font/ttf', otf:'font/otf', mp4:'video/mp4', webm:'video/webm', mp3:'audio/mpeg', wav:'audio/wav', ogg:'audio/ogg',
  };
  get(filename:string):{ mime:string; attachment:boolean } {
    const extension = filename.split('.').at(-1)?.toLowerCase() ?? '';
    const mime = this.types[extension];
    return { mime:mime ?? 'application/octet-stream', attachment:!mime };
  }
}
