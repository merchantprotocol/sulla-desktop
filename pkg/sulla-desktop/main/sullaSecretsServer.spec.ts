// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@pkg/agent/services/FunctionBrowserCompositionRoot', () => ({
  functionBrowserCompositionRoot: { capabilities: { shutdown: vi.fn() } },
}));

import { FunctionBrowserRequestHandler } from './sullaSecretsServer';

class ResponseRecorder {
  status = 0; headers: Record<string,string> = {}; body = '';
  writeHead(status: number, headers: Record<string,string>): void { this.status=status; this.headers=headers }
  end(body = ''): void { this.body=body }
}

class BrowserServiceStub {
  result: unknown = null;
  async evaluate(): Promise<unknown> { return this.result }
}

function request(): Readable { return Readable.from([Buffer.from(JSON.stringify({ token: 't', tabId: 'tab', code: '1' }))]) }

describe('FunctionBrowserRequestHandler response ceiling', () => {
  let service: BrowserServiceStub; let handler: FunctionBrowserRequestHandler;
  beforeEach(() => { service=new BrowserServiceStub(); handler=new FunctionBrowserRequestHandler(service as any) });

  it('writes a final response of exactly 1 MiB without serializing the result twice', async() => { // risk: memory exhaustion
    let serializations=0; const overhead=Buffer.byteLength('{"result":""}');
    service.result={ toJSON: () => { serializations++; return 'x'.repeat(1024*1024-overhead) } };
    const response=new ResponseRecorder(); await handler.handle('/browser/eval',request() as any,response as any);
    expect(response.status).toBe(200); expect(Buffer.byteLength(response.body)).toBe(1024*1024);
    expect(response.headers['Content-Length']).toBe(String(1024*1024)); expect(serializations).toBe(1);
  });

  it('replaces a final response over 1 MiB with a bounded error', async() => { // risk: memory exhaustion
    const overhead=Buffer.byteLength('{"result":""}'); service.result='x'.repeat(1024*1024-overhead+1);
    const response=new ResponseRecorder(); await handler.handle('/browser/eval',request() as any,response as any);
    expect(response.status).toBe(413); expect(JSON.parse(response.body)).toEqual({error:'browser_result_too_large'});
    expect(Buffer.byteLength(response.body)).toBeLessThan(1024);
  });
});
