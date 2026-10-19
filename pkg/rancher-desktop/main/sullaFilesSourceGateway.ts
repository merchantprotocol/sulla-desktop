import crypto from 'node:crypto';
import fs, { constants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const BIND_HOST = '127.0.0.1';
const DEFAULT_PORT = 30_125;

interface RegisteredSource {
  path:       string;
  parentPath: string;
  release?:   () => void;
}

export interface SullaFilesSourceSnapshot {
  handle:      string;
  bytes:       Buffer;
  contentHash: string;
  revision:    string;
}

export interface SullaFilesSourceWriteResult extends Omit<SullaFilesSourceSnapshot, 'bytes'> {
  conflictHandle?: string;
}

class SourceGatewayError extends Error {
  constructor(readonly status:number, readonly code:string, message:string, readonly conflictHandle?:string) {
    super(message);
  }
}

function safeEqual(left:string, right:string):boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function fingerprint(info:fs.BigIntStats, contentHash:string):string {
  return crypto.createHash('sha256').update([
    info.dev, info.ino, info.size, info.mtimeNs, contentHash,
  ].join(':')).digest('hex');
}

async function syncParent(parentPath:string):Promise<void> {
  const parent = await fs.promises.open(parentPath, constants.O_RDONLY);
  try { await parent.sync() } finally { await parent.close() }
}

export class SullaFilesSourceGateway {
  private readonly sources = new Map<string, RegisteredSource>();
  private server?: http.Server;
  private port = 0;

  constructor(private readonly token:string) {
    if (Buffer.byteLength(token) < 32) throw new Error('Files source gateway token must contain at least 32 bytes');
  }

  get vmUrl():string {
    if (!this.port) throw new Error('Files source gateway is not running');
    return `http://host.lima.internal:${ this.port }`;
  }

  get loopbackUrl():string {
    if (!this.port) throw new Error('Files source gateway is not running');
    return `http://${ BIND_HOST }:${ this.port }`;
  }

  async registerExactFile(sourcePath:string, release?:() => void):Promise<string> {
    try {
      const canonical = await fs.promises.realpath(sourcePath);
      const info = await fs.promises.lstat(canonical, { bigint: true });
      if (!info.isFile() || info.isSymbolicLink()) throw new Error('Files source registration requires one regular file');
      const parentPath = await fs.promises.realpath(path.dirname(canonical));
      const handle = crypto.randomBytes(32).toString('base64url');
      this.sources.set(handle, { path: canonical, parentPath, release });
      return handle;
    } catch (error) {
      release?.();
      throw error;
    }
  }

  revoke(handle:string):void {
    this.sources.get(handle)?.release?.();
    this.sources.delete(handle);
  }

  async read(handle:string):Promise<SullaFilesSourceSnapshot> {
    const source = await this.requireSource(handle);
    const file = await fs.promises.open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES)) throw new SourceGatewayError(413, 'invalid_source', 'Registered source is not a bounded regular file');
      const bytes = await file.readFile();
      const after = await file.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
        throw new SourceGatewayError(409, 'source_changed', 'Registered source changed while it was being read');
      }
      const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
      return { handle, bytes, contentHash, revision: fingerprint(after, contentHash) };
    } finally { await file.close() }
  }

  async write(handle:string, expectedRevision:string, bytes:Buffer):Promise<SullaFilesSourceWriteResult> {
    if (!/^[a-f0-9]{64}$/i.test(expectedRevision)) throw new SourceGatewayError(428, 'revision_required', 'A valid source revision is required');
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new SourceGatewayError(413, 'source_too_large', 'Source write exceeds the experimental size bound');
    const source = await this.requireSource(handle);
    const operationId = crypto.randomUUID();
    const stagedPath = path.join(source.parentPath, `.sulla-source-${ operationId }.staged`);
    const recoveryPath = path.join(source.parentPath, `.sulla-source-${ operationId }.recovery`);
    const originalInfo = await fs.promises.lstat(source.path, { bigint: true });
    const sourceMode = Number(originalInfo.mode & 0o777n);
    let ownsStage = false;
    let ownsRecovery = false;
    try {
      const staged = await fs.promises.open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, sourceMode || 0o600);
      ownsStage = true;
      try { await staged.writeFile(bytes); await staged.sync() } finally { await staged.close() }
      const current = await this.read(handle);
      if (!safeEqual(current.revision.toLowerCase(), expectedRevision.toLowerCase())) {
        const conflictHandle = await this.preserveConflict(source, stagedPath);
        ownsStage = false;
        throw new SourceGatewayError(409, 'source_changed', 'Registered source changed before the conditional write', conflictHandle);
      }
      await fs.promises.link(source.path, recoveryPath);
      ownsRecovery = true;
      const verified = await this.read(handle);
      if (!safeEqual(verified.revision.toLowerCase(), expectedRevision.toLowerCase())) {
        const conflictHandle = await this.preserveConflict(source, stagedPath);
        ownsStage = false;
        throw new SourceGatewayError(409, 'source_changed', 'Registered source changed while the conditional write was staged', conflictHandle);
      }
      await fs.promises.rename(stagedPath, source.path);
      ownsStage = false;
      await syncParent(source.parentPath);
      const result = await this.read(handle);
      const desiredHash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (!safeEqual(result.contentHash, desiredHash)) throw new Error('Published source does not match the staged bytes');
      await fs.promises.unlink(recoveryPath);
      ownsRecovery = false;
      await syncParent(source.parentPath);
      return { handle, contentHash: result.contentHash, revision: result.revision };
    } catch (error) {
      if (error instanceof SourceGatewayError) {
        if (ownsRecovery) {
          await fs.promises.unlink(recoveryPath).catch(() => undefined);
          ownsRecovery = false;
        }
        throw error;
      }
      if (ownsRecovery) {
        const current = await this.read(handle).catch(() => undefined);
        const desiredHash = crypto.createHash('sha256').update(bytes).digest('hex');
        if (current?.contentHash === desiredHash) {
          await fs.promises.rename(recoveryPath, source.path).then(async() => {
            ownsRecovery = false;
            await syncParent(source.parentPath);
          }).catch(() => undefined);
        }
      }
      throw new SourceGatewayError(503, 'source_write_failed', 'Native source write stopped with recovery state preserved');
    } finally {
      if (ownsStage) await fs.promises.unlink(stagedPath).catch(() => undefined);
      // A recovery link is deliberately retained if rollback could not be proven.
    }
  }

  async start(port = 0):Promise<void> {
    if (this.server) return;
    const server = http.createServer((request, response) => {
      this.route(request, response).catch(error => this.sendError(response, error));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, BIND_HOST, () => resolve());
    });
    this.server = server;
    const address = server.address();
    this.port = address && typeof address === 'object' ? address.port : 0;
  }

  async stop():Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.port = 0;
    if (server) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    for (const source of this.sources.values()) source.release?.();
    this.sources.clear();
  }

  private async requireSource(handle:string):Promise<RegisteredSource> {
    const source = this.sources.get(handle);
    if (!source) throw new SourceGatewayError(404, 'unknown_source', 'Source handle is unknown or revoked');
    const parentPath = await fs.promises.realpath(path.dirname(source.path)).catch(() => '');
    if (parentPath !== source.parentPath) throw new SourceGatewayError(409, 'source_parent_changed', 'Registered source parent changed');
    return source;
  }

  private async preserveConflict(source:RegisteredSource, stagedPath:string):Promise<string> {
    const conflictPath = path.join(source.parentPath, `.sulla-source-conflict-${ crypto.randomUUID() }`);
    await fs.promises.rename(stagedPath, conflictPath);
    await syncParent(source.parentPath);
    const conflictHandle = crypto.randomBytes(32).toString('base64url');
    this.sources.set(conflictHandle, { path: conflictPath, parentPath: source.parentPath });
    return conflictHandle;
  }

  private async route(request:http.IncomingMessage, response:http.ServerResponse):Promise<void> {
    const provided = request.headers['x-sulla-files-token'];
    if (typeof provided !== 'string' || !safeEqual(provided, this.token)) throw new SourceGatewayError(401, 'unauthorized', 'Files source gateway authorization failed');
    const match = request.url?.match(/^\/v1\/sources\/([A-Za-z0-9_-]+)$/);
    if (!match) throw new SourceGatewayError(404, 'not_found', 'Route not found');
    const handle = match[1];
    await this.requireSource(handle);
    if (request.method === 'GET') {
      const snapshot = await this.read(handle);
      response.writeHead(200, {
        'cache-control':       'private, no-store',
        'content-length':      String(snapshot.bytes.byteLength),
        'content-type':        'application/octet-stream',
        etag:                  `"${ snapshot.revision }"`,
        'x-sulla-source-hash': snapshot.contentHash,
      });
      response.end(snapshot.bytes);
      return;
    }
    if (request.method === 'PUT') {
      const expectedRevision = request.headers['if-match']?.match(/^"([a-f0-9]{64})"$/i)?.[1] ?? '';
      const bytes = await this.readBody(request);
      const result = await this.write(handle, expectedRevision, bytes);
      this.sendJson(response, 200, result);
      return;
    }
    throw new SourceGatewayError(405, 'method_not_allowed', 'Method not allowed');
  }

  private readBody(request:http.IncomingMessage):Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const chunks:Buffer[] = [];
      let total = 0;
      request.on('data', (chunk:Buffer) => {
        total += chunk.byteLength;
        if (total > MAX_SOURCE_BYTES) {
          reject(new SourceGatewayError(413, 'source_too_large', 'Source write exceeds the experimental size bound'));
          request.destroy();
        } else chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks)));
      request.on('error', reject);
    });
  }

  private sendError(response:http.ServerResponse, error:unknown):void {
    const known = error instanceof SourceGatewayError ? error : new SourceGatewayError(500, 'internal_error', 'Files source gateway failed');
    this.sendJson(response, known.status, { error: known.code, ...(known.conflictHandle ? { conflictHandle: known.conflictHandle } : {}) });
  }

  private sendJson(response:http.ServerResponse, status:number, value:unknown):void {
    const body = Buffer.from(JSON.stringify(value));
    response.writeHead(status, { 'cache-control': 'private, no-store', 'content-length': String(body.byteLength), 'content-type': 'application/json' });
    response.end(body);
  }
}

let sourceGateway:SullaFilesSourceGateway | undefined;

export async function startSullaFilesSourceGateway(token:string):Promise<SullaFilesSourceGateway> {
  if (sourceGateway) return sourceGateway;
  const gateway = new SullaFilesSourceGateway(token);
  await gateway.start(DEFAULT_PORT);
  sourceGateway = gateway;
  return gateway;
}

export function getSullaFilesSourceGateway():SullaFilesSourceGateway {
  if (!sourceGateway) throw new Error('Experimental native Files source gateway is not running');
  return sourceGateway;
}

export async function stopSullaFilesSourceGateway():Promise<void> {
  const gateway = sourceGateway;
  sourceGateway = undefined;
  await gateway?.stop();
}
