// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import { LocalVaultError } from './LocalVaultError.js';

/**
 * Request/response body and header shaping for brokered HTTP: serialization, case-insensitive
 * header lookup, form/JSON credential injection and bodyless stream detection.
 * Moved verbatim from localAuthority.ts (E9). Static methods never use `this`.
 */
export class BrokerHttpBody {
  static serializeBrokerBody(body: unknown): Buffer {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof URLSearchParams) return Buffer.from(body.toString());
    return Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  }

  static headerValue(headers: Record<string, string>, name: string): string | undefined {
    const key = Object.keys(headers).find(entry => entry.toLowerCase() === name);
    return key === undefined ? undefined : headers[key];
  }

  /** Sets content-type once, dropping any differently-cased copy the caller sent. */
  static setContentType(headers: Record<string, string>, value: string): void {
    for (const key of Object.keys(headers)) if (key.toLowerCase() === 'content-type') delete headers[key];
    headers['content-type'] = value;
  }

  static formFromObject(body: unknown): URLSearchParams {
    return new URLSearchParams(Object.entries(body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {})
      .filter(([, entry]) => ['string', 'number', 'boolean'].includes(typeof entry))
      .map(([name, entry]) => [name, String(entry)]));
  }

  static applyJsonPath(root: unknown, path: string, value: string): unknown {
    if (!path || !/^[A-Za-z0-9_.-]+$/.test(path)) throw new LocalVaultError('invalid_injection', 400, 'Invalid JSON injection path');
    const output = root && typeof root === 'object' && !Array.isArray(root) ? structuredClone(root) as Record<string, unknown> : {};
    const parts = path.split('.');
    if (parts.some(part => ['__proto__', 'prototype', 'constructor'].includes(part))) {
      throw new LocalVaultError('invalid_injection', 400, 'Unsafe JSON injection path');
    }
    let current = output;
    for (const part of parts.slice(0, -1)) {
      const child = current[part];
      current[part] = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
      current = current[part] as Record<string, unknown>;
    }
    current[parts.at(-1)!] = value;
    return output;
  }

  static streamResponseIsBodyless(method: string, status: number, contentLength: string | string[] | undefined): boolean {
    return method === 'HEAD' || [202, 204, 205, 304].includes(status) || contentLength === '0';
  }
}
