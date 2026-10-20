import { createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { FILES_BOOTSTRAP_DESTINATION, filesChallengeProofInput, filesServerProofInput, filesSessionContext, filesUnlockProofInput, } from './bootstrapProtocol.js';
const NONCE = /^[A-Za-z0-9_-]{32,128}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const PROOF = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const CHALLENGE_TTL_MS = 30_000;
const MAX_CHALLENGES = 32;
const MAX_SEALED_LENGTH = 16_384;
const MAX_LEGACY_KEYS = 8;
export class FilesBootstrapError extends Error {
    code;
    status;
    constructor(code, status, message) {
        super(message);
        this.code = code;
        this.status = status;
    }
}
function hmac(key, input) {
    return createHmac('sha256', Buffer.from(key, 'utf8')).update(input, 'utf8').digest('base64url');
}
function equal(left, right) {
    const a = Buffer.from(left, 'base64url');
    const b = Buffer.from(right, 'base64url');
    return a.length === b.length && timingSafeEqual(a, b);
}
export class FilesBootstrapAuthority {
    callerId;
    identity;
    lifecycle;
    challenges = new Map();
    constructor(callerId, identity, lifecycle) {
        this.callerId = callerId;
        this.identity = identity;
        this.lifecycle = lifecycle;
        if (Buffer.byteLength(identity) < 32)
            throw new Error('Files bootstrap identity must contain at least 32 bytes');
    }
    async challenge(input) {
        this.expire();
        if (this.challenges.size >= MAX_CHALLENGES)
            throw new FilesBootstrapError('FILES_BOOTSTRAP_RATE_LIMIT', 429, 'Too many bootstrap challenges');
        if (!input || typeof input !== 'object' || typeof input.callerId !== 'string' ||
            typeof input.destination !== 'string' || typeof input.clientNonce !== 'string' ||
            typeof input.clientProof !== 'string' || typeof input.hasMasterBlob !== 'boolean' ||
            input.destination !== FILES_BOOTSTRAP_DESTINATION || input.callerId !== this.callerId || !NONCE.test(input.clientNonce) ||
            !PROOF.test(input.clientProof) ||
            !equal(input.clientProof, hmac(this.identity, filesChallengeProofInput(input.callerId, input.clientNonce, input.hasMasterBlob)))) {
            throw new FilesBootstrapError('FILES_BOOTSTRAP_IDENTITY_INVALID', 401, 'Files bootstrap identity is invalid');
        }
        const generation = this.lifecycle.generation;
        const disposition = await this.lifecycle.disposition(input.hasMasterBlob);
        if (generation !== this.lifecycle.generation) {
            throw new FilesBootstrapError('FILES_BOOTSTRAP_CANCELLED', 409, 'Files locked during bootstrap challenge');
        }
        const challengeId = randomBytes(32).toString('base64url');
        const serverNonce = randomBytes(32).toString('base64url');
        const expiresAt = Date.now() + CHALLENGE_TTL_MS;
        this.challenges.set(challengeId, {
            callerId: input.callerId, clientNonce: input.clientNonce, serverNonce, expiresAt,
            disposition, generation, hasMasterBlob: input.hasMasterBlob,
        });
        return {
            challengeId, serverNonce, expiresAt, disposition, destination: FILES_BOOTSTRAP_DESTINATION,
            serverProof: hmac(this.identity, filesServerProofInput(input.callerId, input.clientNonce, serverNonce, challengeId, expiresAt, disposition, input.hasMasterBlob)),
        };
    }
    async unlock(input) {
        if (!input || typeof input !== 'object' || typeof input.challengeId !== 'string' || !NONCE.test(input.challengeId)) {
            throw new FilesBootstrapError('FILES_BOOTSTRAP_REQUEST_INVALID', 400, 'Files bootstrap request is invalid');
        }
        const challenge = this.challenges.get(input.challengeId);
        // A syntactically addressable challenge is consumed before validating any
        // remaining field, so malformed and forged retries cannot probe it.
        this.challenges.delete(input.challengeId);
        if (typeof input.callerId !== 'string' || typeof input.destination !== 'string' ||
            typeof input.sealedUnlock !== 'string' || typeof input.clientProof !== 'string' ||
            !BASE64URL.test(input.sealedUnlock) ||
            input.sealedUnlock.length > MAX_SEALED_LENGTH || !PROOF.test(input.clientProof)) {
            throw new FilesBootstrapError('FILES_BOOTSTRAP_REQUEST_INVALID', 400, 'Files bootstrap request is invalid');
        }
        if (!challenge || input.destination !== FILES_BOOTSTRAP_DESTINATION || input.callerId !== challenge.callerId ||
            challenge.expiresAt <= Date.now() || challenge.generation !== this.lifecycle.generation ||
            !equal(input.clientProof, hmac(this.identity, filesUnlockProofInput(input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt, challenge.disposition, challenge.hasMasterBlob, input.sealedUnlock)))) {
            throw new FilesBootstrapError('FILES_BOOTSTRAP_CHALLENGE_INVALID', 401, 'Files bootstrap challenge is invalid or expired');
        }
        const sessionContext = filesSessionContext(input.callerId, challenge.clientNonce, challenge.serverNonce, input.challengeId, challenge.expiresAt, challenge.disposition, challenge.hasMasterBlob);
        const sessionKey = createHmac('sha256', Buffer.from(this.identity, 'utf8')).update(sessionContext, 'utf8').digest();
        const sealed = Buffer.from(input.sealedUnlock, 'base64url');
        let clear;
        let masterKey;
        const legacyMasterKeys = [];
        try {
            if (sealed.length < 29)
                throw new Error('truncated');
            const decipher = createDecipheriv('aes-256-gcm', sessionKey, sealed.subarray(0, 12));
            decipher.setAAD(Buffer.from(sessionContext, 'utf8'));
            decipher.setAuthTag(sealed.subarray(12, 28));
            clear = Buffer.concat([decipher.update(sealed.subarray(28)), decipher.final()]);
            const material = JSON.parse(clear.toString('utf8'));
            if (typeof material.masterKey !== 'string' || !Array.isArray(material.legacyMasterKeys) ||
                !KEY.test(material.masterKey) || material.legacyMasterKeys.length > MAX_LEGACY_KEYS ||
                material.legacyMasterKeys.some(value => typeof value !== 'string' || !KEY.test(value)))
                throw new Error('shape');
            masterKey = Buffer.from(material.masterKey, 'base64url');
            for (const value of material.legacyMasterKeys)
                legacyMasterKeys.push(Buffer.from(value, 'base64url'));
            if (masterKey.length !== 32 || legacyMasterKeys.some(key => key.length !== 32))
                throw new Error('length');
        }
        catch (error) {
            sessionKey.fill(0);
            sealed.fill(0);
            clear?.fill(0);
            masterKey?.fill(0);
            for (const key of legacyMasterKeys)
                key.fill(0);
            throw new FilesBootstrapError('FILES_BOOTSTRAP_MATERIAL_INVALID', 400, 'Files bootstrap material is invalid');
        }
        try {
            return await this.lifecycle.bootstrap({ masterKey, legacyMasterKeys }, challenge.disposition, challenge.generation);
        }
        finally {
            sessionKey.fill(0);
            sealed.fill(0);
            clear?.fill(0);
            masterKey?.fill(0);
            for (const key of legacyMasterKeys)
                key.fill(0);
        }
    }
    invalidate() { this.challenges.clear(); }
    expire() {
        const now = Date.now();
        for (const [id, challenge] of this.challenges)
            if (challenge.expiresAt <= now)
                this.challenges.delete(id);
    }
}
