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

export interface NativeSourceAuthority {
  capability: string;
  serviceId:  'sulla-files';
}

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/i;

export class NativeSourceError extends Error {
  constructor(readonly status:number, readonly code:string, readonly conflictHandle?:string) {
    super(`Native Files source request failed: ${ code }`);
  }
}

export class NativeSourceClient {
  constructor(private readonly origin:string) {
    const url = new URL(origin);
    if (url.protocol !== 'http:' || !['host.lima.internal', '127.0.0.1', 'localhost'].includes(url.hostname) || url.username || url.password || url.pathname !== '/') {
      throw new Error('Native Files source gateway must use the local VM-to-host broker origin');
    }
  }

  async read(handle:string, authority:NativeSourceAuthority):Promise<NativeSourceSnapshot> {
    const response = await this.request(handle, authority, { method: 'GET' });
    const revision = response.headers.get('etag')?.match(/^"([a-f0-9]{64})"$/i)?.[1];
    const contentHash = response.headers.get('x-sulla-source-hash');
    if (!revision || !contentHash?.match(HASH_PATTERN)) throw new Error('Native Files source response omitted integrity metadata');
    const bytes = await this.readBounded(response, MAX_SOURCE_BYTES);
    return { bytes, revision, contentHash: contentHash.toLowerCase() };
  }

  async write(handle:string, authority:NativeSourceAuthority, expectedRevision:string, bytes:Buffer):Promise<NativeSourceWriteResult> {
    if (!HASH_PATTERN.exec(expectedRevision)) throw new Error('Native Files source write requires the exact prior revision');
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new Error('Native Files source write exceeds the size bound');
    const body = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(body).set(bytes);
    const response = await this.request(handle, authority, { method: 'PUT', headers: { 'if-match': `"${ expectedRevision }"` }, body });
    const value = JSON.parse((await this.readBounded(response, MAX_JSON_BYTES)).toString()) as Partial<NativeSourceWriteResult>;
    if (value.handle !== handle || !HASH_PATTERN.test(value.contentHash ?? '') || !HASH_PATTERN.test(value.revision ?? '') ||
        (value.conflictHandle !== undefined && !HANDLE_PATTERN.test(value.conflictHandle))) {
      throw new Error('Native Files source write response failed schema validation');
    }
    return value as NativeSourceWriteResult;
  }

  private async request(handle:string, authority:NativeSourceAuthority, init:RequestInit):Promise<Response> {
    if (!HANDLE_PATTERN.exec(handle)) throw new Error('Native Files source handle is invalid');
    if (!HANDLE_PATTERN.exec(authority.capability) || authority.serviceId !== 'sulla-files') throw new Error('Native Files source capability is invalid');
    const response = await fetch(new URL(`/v1/sources/${ encodeURIComponent(handle) }`, this.origin), {
      ...init,
      headers:  {
        ...init.headers,
        'x-sulla-source-capability': authority.capability,
        'x-sulla-source-service':    authority.serviceId,
      },
      redirect: 'error',
      signal:   AbortSignal.timeout(30_000),
    });
    if (response.ok) return response;
    const body = await this.readBounded(response, MAX_JSON_BYTES).then(value => JSON.parse(value.toString())).catch(() => ({})) as { error?: unknown; conflictHandle?: unknown };
    throw new NativeSourceError(response.status, typeof body.error === 'string' ? body.error : 'gateway_error', typeof body.conflictHandle === 'string' ? body.conflictHandle : undefined);
  }

  private async readBounded(response:Response, limit:number):Promise<Buffer> {
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > limit) throw new Error('Native Files source response exceeds the size bound');
    if (!response.body) return Buffer.alloc(0);
    const reader = response.body.getReader();
    const chunks:Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > limit) throw new Error('Native Files source response exceeds the size bound');
        chunks.push(Buffer.from(value));
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    if (declared && total !== declared) throw new Error('Native Files source response length does not match its declaration');
    return Buffer.concat(chunks, total);
  }
}
