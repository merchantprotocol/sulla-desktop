// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// Sulla Files sync envelope v1 (FILES-SYNC-DESIGN.md §3).
// 1:1 TypeScript port of FILES-SYNC-ENVELOPE-v1 (the reference ES module). Output must stay
// byte-identical to files-sync-v1-kat.json (pinned by tests/CloudSyncEnvelope.test.ts).
// The code lives in SyncCryptoPrimitives, SyncEnvelopeCodec and SyncEscrowCodec; this module
// keeps the long-standing named exports as stateless delegates for existing callers.

import { SyncCryptoPrimitives } from './SyncCryptoPrimitives.js';
import { SyncEnvelopeCodec } from './SyncEnvelopeCodec.js';
import { SyncEscrowCodec } from './SyncEscrowCodec.js';

export type { SubkeyPurpose, ManifestPlain, NamespaceManifestPlain, ManifestEnvelope, SyncHead, EscrowEnvelope, TransportEnvelope, CollectionInfoEnvelope, CollectionInfoPlain, StateEntry } from './envelopeTypes.js';
export { SyncCryptoPrimitives } from './SyncCryptoPrimitives.js';
export { SyncEnvelopeCodec } from './SyncEnvelopeCodec.js';
export { SyncEscrowCodec } from './SyncEscrowCodec.js';

export const FLAG_DEFLATE_RAW = SyncEnvelopeCodec.flagDeflateRaw;
export const CHUNK_PLAIN_BYTES = SyncEnvelopeCodec.chunkPlainBytes;

const primitives = new SyncCryptoPrimitives();
const codec = new SyncEnvelopeCodec(primitives);
const escrow = new SyncEscrowCodec(primitives);

export const b64u:SyncCryptoPrimitives['b64u'] = primitives.b64u.bind(primitives);
export const unb64u:SyncCryptoPrimitives['unb64u'] = primitives.unb64u.bind(primitives);
export const hex:SyncCryptoPrimitives['hex'] = primitives.hex.bind(primitives);
export const sha256Hex:SyncCryptoPrimitives['sha256Hex'] = primitives.sha256Hex.bind(primitives);
export const subkey:SyncCryptoPrimitives['subkey'] = primitives.subkey.bind(primitives);

export const chunkId:SyncEnvelopeCodec['chunkId'] = codec.chunkId.bind(codec);
export const sealChunk:SyncEnvelopeCodec['sealChunk'] = codec.sealChunk.bind(codec);
export const openChunk:SyncEnvelopeCodec['openChunk'] = codec.openChunk.bind(codec);
export const sealManifest:SyncEnvelopeCodec['sealManifest'] = codec.sealManifest.bind(codec);
export const openManifest:SyncEnvelopeCodec['openManifest'] = codec.openManifest.bind(codec);
export const sealCollectionInfo:SyncEnvelopeCodec['sealCollectionInfo'] = codec.sealCollectionInfo.bind(codec);
export const openCollectionInfo:SyncEnvelopeCodec['openCollectionInfo'] = codec.openCollectionInfo.bind(codec);
export const stateHash:SyncEnvelopeCodec['stateHash'] = codec.stateHash.bind(codec);
export const signHead:SyncEnvelopeCodec['signHead'] = codec.signHead.bind(codec);
export const verifyHead:SyncEnvelopeCodec['verifyHead'] = codec.verifyHead.bind(codec);

export const escrowKey:SyncEscrowCodec['escrowKey'] = escrow.escrowKey.bind(escrow);
export const sealEscrow:SyncEscrowCodec['sealEscrow'] = escrow.sealEscrow.bind(escrow);
export const openEscrow:SyncEscrowCodec['openEscrow'] = escrow.openEscrow.bind(escrow);
export const sealEscrowWithKey:SyncEscrowCodec['sealEscrowWithKey'] = escrow.sealEscrowWithKey.bind(escrow);
export const openEscrowWithKey:SyncEscrowCodec['openEscrowWithKey'] = escrow.openEscrowWithKey.bind(escrow);
export const generateTransportKeyPair:SyncEscrowCodec['generateTransportKeyPair'] = escrow.generateTransportKeyPair.bind(escrow);
export const transportWrapBytes:SyncEscrowCodec['transportWrapBytes'] = escrow.transportWrapBytes.bind(escrow);
export const transportUnwrapBytes:SyncEscrowCodec['transportUnwrapBytes'] = escrow.transportUnwrapBytes.bind(escrow);
export const transportWrap:SyncEscrowCodec['transportWrap'] = escrow.transportWrap.bind(escrow);
export const transportUnwrap:SyncEscrowCodec['transportUnwrap'] = escrow.transportUnwrap.bind(escrow);
