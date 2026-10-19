import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FilesIdentity } from './auth.js';

/** Kept inside Files and Electron main. Never send this structure to a renderer. */
export interface OriginalRevealTarget {
  rootId:string; collectionId:string; relativePath:string; fileId:string;
  versionId:string; revision:string; hash:string; size:number; mtimeMs:number;
}
const actorKey = (actor:FilesIdentity) => JSON.stringify([actor.userId,actor.deviceId,actor.kind,actor.agentId,actor.jobId,actor.threadId]);
const invalid = () => Object.assign(new Error('Original reveal attestation expired, consumed or invalid'), { status:409,code:'original-attestation-invalid' });

/** Random, signed handles keep paths opaque; restart invalidates all handles. */
export class OriginalRevealAttestations {
  private readonly key = randomBytes(32);
  private readonly pending = new Map<string,{ actor:string; target:OriginalRevealTarget; expiresAt:number }>();

  issue(actor:FilesIdentity,target:OriginalRevealTarget):{ token:string; expiresAt:number } {
    const now = Date.now();
    for (const [id,value] of this.pending) if (value.expiresAt <= now) this.pending.delete(id);
    if (this.pending.size >= 1024) throw Object.assign(new Error('Too many pending reveal requests'), { status:429,code:'original-reveal-busy' });
    const id = randomBytes(32).toString('base64url'); const expiresAt = now + 15_000;
    this.pending.set(id,{ actor:actorKey(actor),target,expiresAt });
    return { token:id + '.' + createHmac('sha256',this.key).update(id).digest('base64url'),expiresAt };
  }

  consume(actor:FilesIdentity,token:unknown):OriginalRevealTarget {
    if (typeof token !== 'string' || token.length > 200) throw invalid();
    const [id,signature,extra] = token.split('.');
    if (!id || !signature || extra) throw invalid();
    const expected = createHmac('sha256',this.key).update(id).digest();
    const actual = Buffer.from(signature,'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual,expected)) throw invalid();
    const value = this.pending.get(id);
    if (!value || value.actor !== actorKey(actor) || value.expiresAt <= Date.now()) throw invalid();
    this.pending.delete(id);
    return value.target;
  }
}
