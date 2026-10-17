import { randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export class Store {
  constructor(private root:string) {}

  path(collectionId:string, id:string) {
    if (!/^[a-f0-9]{64}$/.test(id) || !/^[\w-]+$/.test(collectionId)) throw new Error('bad chunk');
    return join(this.root, collectionId, id.slice(0, 2), id);
  }

  async has(collectionId:string, id:string) {
    let handle;
    try {
      handle = await open(this.path(collectionId, id), constants.O_RDONLY | constants.O_NOFOLLOW);
      return (await handle.stat()).isFile();
    } catch { return false } finally { await handle?.close() }
  }

  async get(collectionId:string, id:string) {
    return readFile(this.path(collectionId, id));
  }

  async getBounded(collectionId:string, id:string, maxBytes:number, expectedBytes:number):Promise<Buffer> {
    if (!Number.isSafeInteger(maxBytes) || !Number.isSafeInteger(expectedBytes) || maxBytes < 0 || expectedBytes < 0 || expectedBytes > maxBytes) throw new Error('Invalid chunk read bound');
    const handle = await open(this.path(collectionId, id), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error(`Invalid stored chunk for ${ id }`);
      const bytes = Buffer.allocUnsafe(expectedBytes);
      let offset = 0;
      while (offset < expectedBytes) {
        const result = await handle.read(bytes, offset, expectedBytes - offset, offset);
        if (result.bytesRead === 0) throw new Error(`Stored chunk is shorter than declared for ${ id }`);
        offset += result.bytesRead;
      }
      const overflow = Buffer.allocUnsafe(1);
      if ((await handle.read(overflow, 0, 1, expectedBytes)).bytesRead !== 0) throw new Error(`Stored chunk is longer than declared for ${ id }`);
      return bytes;
    } finally {
      await handle.close();
    }
  }

  async put(collectionId:string, id:string, bytes:Uint8Array) {
    const target = this.path(collectionId, id);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temp = `${ target }.tmp-${ process.pid }-${ randomUUID() }`;
    let ownsTemp = false;
    try {
      const handle = await open(temp, 'wx', 0o600);
      ownsTemp = true;
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
      try {
        await link(temp, target);
      } catch (error:any) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = await this.getBounded(collectionId, id, bytes.byteLength, bytes.byteLength);
        if (!timingSafeEqual(existing, Buffer.from(bytes))) throw new Error(`Immutable chunk collision for ${ id }`);
      }
    } finally {
      if (ownsTemp) await rm(temp, { force: true });
    }
  }

  async delete(collectionId:string, id:string) {
    await rm(this.path(collectionId, id), { force: true });
  }
}
