// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { describe, expect, it, vi } from 'vitest';
import { FilesErrorHandlers } from '../src/Http/FilesErrorHandlers.js';

describe('FilesErrorHandlers Cloud share recovery metadata', () => {
  // risk: capture sharing — Desktop must receive the narrow code to offer a safe manual retry.
  it('forwards the stable Cloud-content 404 code without changing the error message', () => {
    const middleware:Array<(...args:any[]) => unknown> = [];
    const app = { use: (handler:(...args:any[]) => unknown) => middleware.push(handler) } as any;
    const response = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    new FilesErrorHandlers({ isConnectionLoss: () => false } as any).register(app);

    middleware.at(-1)!({ status: 502, code: 'SULLA_CLOUD_CONTENT_NOT_FOUND', message: 'Sulla Cloud returned 404' }, { path: '/v1/links' }, response, vi.fn());

    expect(response.status).toHaveBeenCalledWith(502);
    expect(response.json).toHaveBeenCalledWith({ error: 'Sulla Cloud returned 404', code: 'SULLA_CLOUD_CONTENT_NOT_FOUND' });
  });
});
