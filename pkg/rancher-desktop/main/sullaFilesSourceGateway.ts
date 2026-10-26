import crypto from 'node:crypto';
import fs, { constants } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const MAX_CONCURRENT_REQUESTS = 4;
const MAX_TOTAL_INFLIGHT_BYTES = MAX_CONCURRENT_REQUESTS * MAX_SOURCE_BYTES;
const MAX_CAPABILITY_TTL_MS = 5 * 60_000;
const BIND_HOST = '127.0.0.1';

interface RegisteredSource {
  path:       string;
  parentPath: string;
  file:       fs.promises.FileHandle;
  dev:        bigint;
  ino:        bigint;
  epoch:      number;
  release?:   () => void;
}

type SourcePermission = 'read' | 'write';

interface SourceCapability {
  handle:      string;
  serviceId:   string;
  permissions: ReadonlySet<SourcePermission>;
  expiresAt:   number;
  epoch:       number;
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
  private readonly capabilities = new Map<string, SourceCapability>();
  private server?: http.Server;
  private port = 0;
  private epoch = 0;
  private sessionsEnabled = false;
  private activeRequests = 0;
  private reservedBytes = 0;
  private drainWaiters = new Set<() => void>();

  get vmUrl():string {
    if (!this.port) throw new Error('Files source gateway is not running');
    return `http://host.sulla.internal:${ this.port }`;
  }

  /** URL for a job container on the isolated, hostname-routed agent network. */
  get containerUrl():string {
    if (!this.port) throw new Error('Files source gateway is not running');
    return `http://sulla-host-relay:30124/_sulla/${ this.port }`;
  }

  get loopbackUrl():string {
    if (!this.port) throw new Error('Files source gateway is not running');
    return `http://${ BIND_HOST }:${ this.port }`;
  }

  activeHandles():string[] {
    if (!this.sessionsEnabled) return [];
    return [...this.sources].filter(([, source]) => source.epoch === this.epoch).map(([handle]) => handle);
  }

  async registerExactFile(sourcePath:string, release?:() => void):Promise<string> {
    let file:fs.promises.FileHandle | undefined;
    const registrationEpoch = this.epoch;
    try {
      if (!this.sessionsEnabled) throw new SourceGatewayError(423, 'files_locked', 'Native Files source sessions are disabled while Files is locked');
      const selectedInfo = await fs.promises.lstat(sourcePath, { bigint: true });
      if (!selectedInfo.isFile() || selectedInfo.isSymbolicLink()) throw new Error('Files source registration requires one regular file');
      const canonical = await fs.promises.realpath(sourcePath);
      file = await fs.promises.open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
      const [pathInfo, descriptorInfo] = await Promise.all([
        fs.promises.lstat(canonical, { bigint: true }),
        file.stat({ bigint: true }),
      ]);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink() ||
          selectedInfo.dev !== pathInfo.dev || selectedInfo.ino !== pathInfo.ino ||
          pathInfo.dev !== descriptorInfo.dev || pathInfo.ino !== descriptorInfo.ino) {
        throw new SourceGatewayError(409, 'source_identity_changed', 'Selected source identity changed during registration');
      }
      const parentPath = await fs.promises.realpath(path.dirname(canonical));
      if (!this.sessionsEnabled || this.epoch !== registrationEpoch) {
        throw new SourceGatewayError(423, 'files_locked', 'Files locked while the native source was being registered');
      }
      const handle = crypto.randomBytes(32).toString('base64url');
      this.sources.set(handle, {
        path: canonical, parentPath, file, dev: descriptorInfo.dev, ino: descriptorInfo.ino, epoch: registrationEpoch, release,
      });
      file = undefined;
      return handle;
    } catch (error) {
      await file?.close().catch(() => undefined);
      release?.();
      throw error;
    }
  }

  issueCapability(handle:string, serviceId:string, permissions:readonly SourcePermission[], ttlMs = MAX_CAPABILITY_TTL_MS):string {
    const source = this.sources.get(handle);
    if (!(this.sessionsEnabled && source?.epoch === this.epoch)) throw new SourceGatewayError(404, 'unknown_source', 'Source handle is unknown or revoked');
    if (serviceId !== 'sulla-files') throw new Error('Native source capabilities may only be issued to the Files service');
    if (!permissions.length || permissions.some(permission => permission !== 'read' && permission !== 'write')) throw new Error('Native source capability scope is invalid');
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > MAX_CAPABILITY_TTL_MS) throw new Error('Native source capability lifetime is invalid');
    const capability = crypto.randomBytes(32).toString('base64url');
    this.capabilities.set(capability, {
      handle, serviceId, permissions: new Set(permissions), expiresAt: Date.now() + ttlMs, epoch: this.epoch,
    });
    return capability;
  }

  unlock():void {
    if (this.sessionsEnabled) return;
    this.epoch++;
    this.sessionsEnabled = true;
  }

  async lock():Promise<void> {
    this.epoch++;
    this.sessionsEnabled = false;
    this.capabilities.clear();
    if (this.activeRequests) {
      await new Promise<void>(resolve => this.drainWaiters.add(resolve));
    }
    for (const source of this.sources.values()) {
      source.release?.();
      await source.file.close().catch(() => undefined);
    }
    this.sources.clear();
  }

  revoke(handle:string):void {
    const source = this.sources.get(handle);
    source?.release?.();
    source?.file.close().catch(() => undefined);
    this.sources.delete(handle);
    for (const [capability, grant] of this.capabilities) if (grant.handle === handle) this.capabilities.delete(capability);
  }

  /** Cheap change signature (fstat of the pinned descriptor) so pollers can skip re-reading unchanged sources. */
  async signature(handle:string):Promise<string> {
    const source = this.sources.get(handle);
    if (!(this.sessionsEnabled && source?.epoch === this.epoch)) throw new SourceGatewayError(404, 'unknown_source', 'Source handle is unknown or revoked');
    const info = await source.file.stat({ bigint: true });
    return `${ info.dev }:${ info.ino }:${ info.size }:${ info.mtimeNs }:${ info.ctimeNs }`;
  }

  async read(handle:string):Promise<SullaFilesSourceSnapshot> {
    return this.withCapacity(() => this.readPinned(handle));
  }

  private async readPinned(handle:string):Promise<SullaFilesSourceSnapshot> {
    const source = await this.requireSource(handle);
    const before = await source.file.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_SOURCE_BYTES)) throw new SourceGatewayError(413, 'invalid_source', 'Registered source is not a bounded regular file');
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await source.file.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) throw new SourceGatewayError(409, 'source_changed', 'Registered source changed while it was being read');
      offset += bytesRead;
    }
    const after = await source.file.stat({ bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) {
      throw new SourceGatewayError(409, 'source_changed', 'Registered source changed while it was being read');
    }
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    return { handle, bytes, contentHash, revision: fingerprint(after, contentHash) };
  }

  async write(handle:string, expectedRevision:string, bytes:Buffer):Promise<SullaFilesSourceWriteResult> {
    return this.withCapacity(() => this.writePinned(handle, expectedRevision, bytes));
  }

  private async writePinned(handle:string, expectedRevision:string, bytes:Buffer):Promise<SullaFilesSourceWriteResult> {
    if (!/^[a-f0-9]{64}$/i.test(expectedRevision)) throw new SourceGatewayError(428, 'revision_required', 'A valid source revision is required');
    if (bytes.byteLength > MAX_SOURCE_BYTES) throw new SourceGatewayError(413, 'source_too_large', 'Source write exceeds the experimental size bound');
    const source = await this.requireSource(handle);
    const operationId = crypto.randomUUID();
    const stagedPath = path.join(source.parentPath, `.sulla-source-${ operationId }.staged`);
    const recoveryPath = path.join(source.parentPath, `.sulla-source-${ operationId }.recovery`);
    const originalInfo = await fs.promises.lstat(source.path, { bigint: true });
    const sourceMode = Number(originalInfo.mode & BigInt(0o777));
    let ownsStage = false;
    let ownsRecovery = false;
    try {
      const staged = await fs.promises.open(stagedPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, sourceMode || 0o600);
      ownsStage = true;
      try { await staged.writeFile(bytes); await staged.sync() } finally { await staged.close() }
      const current = await this.readPinned(handle);
      if (!safeEqual(current.revision.toLowerCase(), expectedRevision.toLowerCase())) {
        const conflictHandle = await this.preserveConflict(source, stagedPath);
        ownsStage = false;
        throw new SourceGatewayError(409, 'source_changed', 'Registered source changed before the conditional write', conflictHandle);
      }
      await fs.promises.link(source.path, recoveryPath);
      ownsRecovery = true;
      const verified = await this.readPinned(handle);
      if (!safeEqual(verified.revision.toLowerCase(), expectedRevision.toLowerCase())) {
        const conflictHandle = await this.preserveConflict(source, stagedPath);
        ownsStage = false;
        throw new SourceGatewayError(409, 'source_changed', 'Registered source changed while the conditional write was staged', conflictHandle);
      }
      this.assertActive(handle, source);
      await fs.promises.rename(stagedPath, source.path);
      ownsStage = false;
      await syncParent(source.parentPath);
      this.assertActive(handle, source);
      const replacement = await this.openPinnedSource(source.path);
      await source.file.close();
      source.file = replacement.file;
      source.dev = replacement.info.dev;
      source.ino = replacement.info.ino;
      const result = await this.readPinned(handle);
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
        const current = await this.readPinned(handle).catch(() => undefined);
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
      if (!this.reserveRequest()) {
        this.sendError(response, new SourceGatewayError(503, 'gateway_busy', 'Native Files source gateway request limits are reached'));
        request.destroy();
        return;
      }
      this.route(request, response)
        .catch(error => this.sendError(response, error))
        .finally(() => this.releaseRequest());
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
    await this.lock();
  }

  private async requireSource(handle:string):Promise<RegisteredSource> {
    const source = this.sources.get(handle);
    if (!(this.sessionsEnabled && source?.epoch === this.epoch)) throw new SourceGatewayError(404, 'unknown_source', 'Source handle is unknown or revoked');
    const parentPath = await fs.promises.realpath(path.dirname(source.path)).catch(() => '');
    if (parentPath !== source.parentPath) throw new SourceGatewayError(409, 'source_parent_changed', 'Registered source parent changed');
    const pathInfo = await fs.promises.lstat(source.path, { bigint: true }).catch(() => undefined);
    if (!pathInfo?.isFile() || pathInfo.isSymbolicLink() || pathInfo.dev !== source.dev || pathInfo.ino !== source.ino) {
      throw new SourceGatewayError(409, 'source_identity_changed', 'Registered source pathname no longer names the selected file identity');
    }
    return source;
  }

  private assertActive(handle:string, source:RegisteredSource):void {
    if (!this.sessionsEnabled || source.epoch !== this.epoch || this.sources.get(handle) !== source) {
      throw new SourceGatewayError(423, 'files_locked', 'Native source session was revoked during publication');
    }
  }

  private async preserveConflict(source:RegisteredSource, stagedPath:string):Promise<string> {
    if (!this.sessionsEnabled || source.epoch !== this.epoch) throw new SourceGatewayError(423, 'files_locked', 'Files locked before conflict preservation');
    const conflictPath = path.join(source.parentPath, `.sulla-source-conflict-${ crypto.randomUUID() }`);
    await fs.promises.rename(stagedPath, conflictPath);
    await syncParent(source.parentPath);
    const pinned = await this.openPinnedSource(conflictPath);
    try {
      if (!this.sessionsEnabled || source.epoch !== this.epoch) throw new SourceGatewayError(423, 'files_locked', 'Files locked while conflict preservation was completing');
      const conflictHandle = crypto.randomBytes(32).toString('base64url');
      this.sources.set(conflictHandle, {
        path: conflictPath, parentPath: source.parentPath, file: pinned.file, dev: pinned.info.dev, ino: pinned.info.ino, epoch: this.epoch,
      });
      return conflictHandle;
    } catch (error) {
      await pinned.file.close().catch(() => undefined);
      throw error;
    }
  }

  private async openPinnedSource(sourcePath:string):Promise<{
    file: fs.promises.FileHandle;
    info: fs.BigIntStats;
  }> {
    const file = await fs.promises.open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const [pathInfo, descriptorInfo] = await Promise.all([
        fs.promises.lstat(sourcePath, { bigint: true }),
        file.stat({ bigint: true }),
      ]);
      if (!pathInfo.isFile() || pathInfo.isSymbolicLink() || pathInfo.dev !== descriptorInfo.dev || pathInfo.ino !== descriptorInfo.ino) {
        throw new SourceGatewayError(409, 'source_identity_changed', 'Source pathname changed while its identity was being pinned');
      }
      return { file, info: descriptorInfo };
    } catch (error) {
      await file.close().catch(() => undefined);
      throw error;
    }
  }

  private requireCapability(request:http.IncomingMessage, handle:string, permission:SourcePermission):void {
    const token = request.headers['x-sulla-source-capability'];
    const serviceId = request.headers['x-sulla-source-service'];
    if (typeof token !== 'string' || typeof serviceId !== 'string') throw new SourceGatewayError(401, 'unauthorized', 'Native source capability is required');
    const capability = this.capabilities.get(token);
    const allowed = capability?.epoch === this.epoch && capability.expiresAt > Date.now() &&
      capability.handle === handle && capability.serviceId === serviceId && capability.permissions.has(permission);
    if (!allowed) {
      if (capability?.expiresAt && capability.expiresAt <= Date.now()) this.capabilities.delete(token);
      throw new SourceGatewayError(403, 'capability_denied', 'Native source capability is expired, revoked, or outside its exact scope');
    }
  }

  private reserveRequest():boolean {
    if (this.activeRequests >= MAX_CONCURRENT_REQUESTS || this.reservedBytes + MAX_SOURCE_BYTES > MAX_TOTAL_INFLIGHT_BYTES) return false;
    this.activeRequests++;
    this.reservedBytes += MAX_SOURCE_BYTES;
    return true;
  }

  private releaseRequest():void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.reservedBytes = Math.max(0, this.reservedBytes - MAX_SOURCE_BYTES);
    if (!this.activeRequests) {
      for (const resolve of this.drainWaiters) resolve();
      this.drainWaiters.clear();
    }
  }

  private async withCapacity<T>(operation:()=>Promise<T>):Promise<T> {
    if (!this.reserveRequest()) throw new SourceGatewayError(503, 'gateway_busy', 'Native Files source gateway request limits are reached');
    try { return await operation() } finally { this.releaseRequest() }
  }

  private async route(request:http.IncomingMessage, response:http.ServerResponse):Promise<void> {
    const match = request.url?.match(/^\/v1\/sources\/([A-Za-z0-9_-]+)$/);
    if (!match) throw new SourceGatewayError(404, 'not_found', 'Route not found');
    const handle = match[1];
    const permission:SourcePermission = request.method === 'GET' ? 'read' : request.method === 'PUT' ? 'write' : 'read';
    this.requireCapability(request, handle, permission);
    await this.requireSource(handle);
    if (request.method === 'GET') {
      // The HTTP request already owns one capacity reservation.
      const snapshot = await this.readPinned(handle);
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
      const result = await this.writePinned(handle, expectedRevision, bytes);
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

export function startSullaFilesSourceGateway():SullaFilesSourceGateway {
  if (sourceGateway) return sourceGateway;
  const gateway = new SullaFilesSourceGateway();
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

export async function lockSullaFilesSourceGateway():Promise<void> {
  await sourceGateway?.lock();
}

export function unlockSullaFilesSourceGateway():void {
  sourceGateway?.unlock();
}
