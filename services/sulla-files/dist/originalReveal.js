// SPDX-License-Identifier: GPL-2.0-or-later
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const actorKey = (actor) => JSON.stringify([actor.userId, actor.deviceId, actor.kind, actor.agentId, actor.jobId, actor.threadId]);
const invalid = () => Object.assign(new Error('Original reveal attestation expired, consumed or invalid'), { status: 409, code: 'original-attestation-invalid' });
/** Random, signed handles keep paths opaque; restart invalidates all handles. */
export class OriginalRevealAttestations {
    key = randomBytes(32);
    pending = new Map();
    issue(actor, target) {
        const now = Date.now();
        for (const [id, value] of this.pending)
            if (value.expiresAt <= now)
                this.pending.delete(id);
        if (this.pending.size >= 1024)
            throw Object.assign(new Error('Too many pending reveal requests'), { status: 429, code: 'original-reveal-busy' });
        const id = randomBytes(32).toString('base64url');
        const expiresAt = now + 15_000;
        this.pending.set(id, { actor: actorKey(actor), target, expiresAt });
        return { token: id + '.' + createHmac('sha256', this.key).update(id).digest('base64url'), expiresAt };
    }
    consume(actor, token) {
        if (typeof token !== 'string' || token.length > 200)
            throw invalid();
        const [id, signature, extra] = token.split('.');
        if (!id || !signature || extra)
            throw invalid();
        const expected = createHmac('sha256', this.key).update(id).digest();
        const actual = Buffer.from(signature, 'base64url');
        if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
            throw invalid();
        const value = this.pending.get(id);
        if (!value || value.actor !== actorKey(actor) || value.expiresAt <= Date.now())
            throw invalid();
        this.pending.delete(id);
        return value.target;
    }
}
