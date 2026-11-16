// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { createHash } from 'node:crypto';

import type express from 'express';
import type { FilesKeyBundleContext } from '@sulla/vault-crypto';

import { HttpError } from './HttpError.js';

/** Pure parsing and validation of Files request input. No I/O. */
export class FilesRequestInput {
  static cleanPath(value:unknown, allowEmpty = true):string {
    if (typeof value !== 'string') throw new HttpError(400, 'path must be a string');
    const path = value.replaceAll('\\', '/').replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
    if (!path && allowEmpty) return '';
    if ((!allowEmpty && !path) || path.split('/').some(part => !part || part === '.' || part === '..')) throw new HttpError(400, 'invalid Files path');
    return path;
  }

  static folderGuidance(value:unknown, field:'description'|'namingHint', required = false):string | null {
    if (value === undefined || value === null || value === '') {
      if (required) throw new HttpError(400, `${ field } is required when an agent creates a folder`);
      return null;
    }
    if (typeof value !== 'string') throw new HttpError(400, `${ field } must be a string`);
    const text=value.trim(); const limit=field==='description'?2000:500;
    if (!text || text.length>limit) throw new HttpError(400, `${ field } must be between 1 and ${ limit } characters`);
    return text;
  }

  static suggestedFileName(what:string, kind?:string):string {
    const stem=what.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,60) || 'new-file';
    const normalized=(kind??'').toLowerCase().replace(/^\./,'');
    const extensions:Record<string,string>={markdown:'md',document:'md',text:'txt',json:'json',yaml:'yaml',csv:'csv',image:'png',screenshot:'png',video:'mp4',audio:'m4a'};
    const extension=extensions[normalized] ?? (/^[a-z0-9]{1,8}$/.test(normalized)?normalized:'');
    return extension && !stem.endsWith(`.${ extension }`) ? `${ stem }.${ extension }` : stem;
  }

  static numberedPath(path:string, index:number):string {
    const slash = path.lastIndexOf('/');
    const folder = slash >= 0 ? path.slice(0, slash + 1) : '';
    const name = path.slice(slash + 1);
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : '';
    return `${ folder }${ stem } (${ index })${ extension }`;
  }

  static bearer(request:express.Request):string | undefined { return request.header('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] }

  static idempotencyUuid(scope:string):string {
    const hex = createHash('sha256').update(scope).digest('hex').slice(0, 32).split('');

    hex[12] = '5';
    hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
    return `${ hex.slice(0, 8).join('') }-${ hex.slice(8, 12).join('') }-${ hex.slice(12, 16).join('') }-${ hex.slice(16, 20).join('') }-${ hex.slice(20).join('') }`;
  }

  static validateKeyContext(value:unknown, collectionId:string, principalId:string):FilesKeyBundleContext {
    if (!value || typeof value !== 'object') throw new HttpError(400, 'valid version key context is required');
    const context = value as Record<string, unknown>;
    if (context.collectionId !== collectionId || context.principalId !== principalId ||
        !Number.isSafeInteger(context.keyVersion) || Number(context.keyVersion) < 1 ||
        !Number.isSafeInteger(context.epoch) || Number(context.epoch) < 1) {
      throw new HttpError(400, 'version key context does not match the authenticated collection owner');
    }
    return context as unknown as FilesKeyBundleContext;
  }
}
