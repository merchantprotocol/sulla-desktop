export interface NativeSourceSnapshot {
  bytes:       Buffer;
  contentHash: string;
  revision:    string;
}

export interface NativeSourceWriteResult {
  handle:          string;
  contentHash:     string;
  revision:        string;
  conflictHandle?: string;
}

export class NativeSourceError extends Error {
  constructor(readonly status:number, readonly code:string, readonly conflictHandle?:string) {
    super(`Native Files source request failed: ${ code }`);
  }
}

export class NativeSourceClient {
  constructor(private readonly origin:string, private readonly token:string) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['host.lima.internal', '127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') {
      throw new Error('Native Files source gateway must use the local VM-to-host broker origin');
    }
    if (Buffer.byteLength(token) < 32) throw new Error('Native Files source gateway token must contain at least 32 bytes');
  }

  async read(handle:string):Promise<NativeSourceSnapshot> {
    const response = await this.request(handle, { method: 'GET' });
    const revision = response.headers.get('etag')?.match(/^"([a-f0-9]{64})"$/i)?.[1];
    const contentHash = response.headers.get('x-sulla-source-hash');
    if (!revision || !contentHash?.match(/^[a-f0-9]{64}$/i)) throw new Error('Native Files source response omitted integrity metadata');
    return { bytes: Buffer.from(await response.arrayBuffer()), revision, contentHash: contentHash.toLowerCase() };
  }

  async write(handle:string, expectedRevision:string, bytes:Buffer):Promise<NativeSourceWriteResult> {
    if (!/^[a-f0-9]{64}$/i.exec(expectedRevision)) throw new Error('Native Files source write requires the exact prior revision');
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.request(handle, { method: 'PUT', headers: { 'if-match': `"${ expectedRevision }"` }, body });
    return await response.json() as NativeSourceWriteResult;
  }

  private async request(handle:string, init:RequestInit):Promise<Response> {
    if (!/^[A-Za-z0-9_-]{40,64}$/.exec(handle)) throw new Error('Native Files source handle is invalid');
    const response = await fetch(new URL(`/v1/sources/${ encodeURIComponent(handle) }`, this.origin), {
      ...init,
      headers:  { ...init.headers, 'x-sulla-files-token': this.token },
      redirect: 'error',
      signal:   AbortSignal.timeout(30_000),
    });
    if (response.ok) return response;
    const body = await response.json().catch(() => ({})) as { error?: unknown; conflictHandle?: unknown };
    throw new NativeSourceError(response.status, typeof body.error === 'string' ? body.error : 'gateway_error', typeof body.conflictHandle === 'string' ? body.conflictHandle : undefined);
  }
}
