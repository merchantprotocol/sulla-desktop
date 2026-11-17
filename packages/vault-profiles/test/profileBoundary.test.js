// risk: profile isolation — requests must resolve one profile and reject missing/ambiguous ids.
// risk: stale work — requests from an earlier profile generation must fail closed.
// risk: SQL/database-name injection — Cloud identities must never enter identifier construction.
// risk: secret disclosure — catalog and log DTOs must contain metadata only.
import assert from 'node:assert/strict';
import test from 'node:test';
import { ProfileBoundary, ProfileCatalogEntry, ProfileGeneration } from '../src/index.js';

const boundary = new ProfileBoundary();
const entry = new ProfileCatalogEntry({ cloudUserId: 'cloud-user-a', displayLabel: 'Jonathon account' });

test('resolver rejects missing and ambiguous profile ids', () => {
  assert.throws(() => boundary.resolve([entry], undefined), /Missing profile id/);
  assert.throws(() => boundary.resolve([entry], 'profile_unknown'), /Unknown profile id/);
  assert.throws(() => boundary.resolve([entry, entry], entry.profileId.value), /Ambiguous profile id/);
});

test('generation fence refuses stale and malformed work', () => {
  assert.throws(() => boundary.assertCurrent(new ProfileGeneration(4), new ProfileGeneration(5)), /Stale profile generation/);
  assert.throws(() => boundary.assertCurrent(undefined, 5), /Missing profile generation/);
  assert.doesNotThrow(() => boundary.assertCurrent(5, 5));
});

test('hostile Cloud IDs never enter the database identifier and invalid collisions fail closed', () => {
  const cloudUserId = "x'); DROP DATABASE sulla_vault; --";
  const hostile = new ProfileCatalogEntry({ cloudUserId, displayLabel: 'Known account' });
  assert.match(hostile.dbIdentifier, /^sulla_vault_[a-f0-9]{48}$/);
  assert.equal(hostile.dbIdentifier.includes(cloudUserId), false);
  assert.doesNotThrow(() => boundary.assertCollisionSafe([hostile]));
  assert.throws(() => boundary.assertCollisionSafe([
    hostile,
    { cloudUserId: 'other-account', dbIdentifier: hostile.dbIdentifier },
  ]), /collision/);
  assert.throws(() => boundary.assertCollisionSafe([
    { cloudUserId, dbIdentifier: `sulla_vault_${cloudUserId}` },
  ]), /Invalid profile database identifier/);
});

test('catalog and log DTO serializers whitelist metadata and omit supplied secrets', () => {
  const dto = boundary.serializeCatalogEntry({
    ...entry.toJSON(), accessToken: 'synthetic-token', privateKey: 'synthetic-key',
  });
  assert.deepEqual(Object.keys(dto).sort(), ['cloudUserId', 'dbIdentifier', 'displayLabel', 'generation', 'migrationState', 'profileId'].sort());
  assert.equal(JSON.stringify(dto).includes('synthetic-'), false);
  const log = boundary.serializeLogDto({ profileId: entry.profileId, generation: 0, event: 'profile-selected', accessToken: 'synthetic-token' });
  assert.deepEqual(log, { profileId: entry.profileId.value, generation: 0, event: 'profile-selected' });
  assert.equal(JSON.stringify(log).includes('synthetic-token'), false);
});
