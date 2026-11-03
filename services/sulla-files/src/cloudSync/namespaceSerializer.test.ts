// SPDX-License-Identifier: GPL-2.0-or-later
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { serializeNamespaceEvent, serializeRecursiveDelete } from './namespaceSerializer.js';

test('rename preserves itemId and reuses content as metadata', () => {
  const value = serializeNamespaceEvent({itemId:'00000000-0000-4000-8000-000000000001',kind:'file',name:'renamed.txt',parentFolderId:null,mime:'text/plain',size:3,mtime:2,sha256:'a'.repeat(64),chunks:[['b'.repeat(64),3]],parentVersionId:'00000000-0000-4000-8000-000000000101',operation:'metadata'});
  assert.equal(value.itemId, '00000000-0000-4000-8000-000000000001');
  assert.equal(value.operation, 'metadata');
});

test('move changes only parentFolderId', () => {
  const value = serializeNamespaceEvent({itemId:'00000000-0000-4000-8000-000000000001',kind:'file',name:'a.txt',parentFolderId:'00000000-0000-4000-8000-000000000002',mime:'text/plain',size:3,mtime:2,sha256:'a'.repeat(64),chunks:[['b'.repeat(64),3]],parentVersionId:'00000000-0000-4000-8000-000000000101',operation:'metadata'});
  assert.equal(value.parentFolderId, '00000000-0000-4000-8000-000000000002');
  assert.deepEqual(value.chunks, [['b'.repeat(64),3]]);
});

test('recursive delete batches 600 entries as 256, 256, 88 with final only on last', () => {
  const entries = Array.from({length:600}, (_, index) => ({itemId:`00000000-0000-4000-8000-${String(index+10).padStart(12,'0')}`,kind:'file' as const,name:`f${index}`,parentFolderId:null,mime:'text/plain',mtime:index,parentVersionId:'00000000-0000-4000-8000-000000000101'}));
  const batches = serializeRecursiveDelete('00000000-0000-4000-8000-000000000002', entries, 'batch');
  assert.deepEqual(batches.map(batch => batch.versions.length), [256,256,88]);
  assert.deepEqual(batches.map(batch => batch.final), [false,false,true]);
});

test('restore carries source version', () => {
  const value = serializeNamespaceEvent({itemId:'00000000-0000-4000-8000-000000000001',kind:'file',name:'a',parentFolderId:null,mime:'text/plain',size:0,mtime:4,sha256:'a'.repeat(64),chunks:[],parentVersionId:'00000000-0000-4000-8000-000000000101',operation:'restore',restoredFromVersionId:'00000000-0000-4000-8000-000000000099'});
  assert.equal(value.restoredFromVersionId, '00000000-0000-4000-8000-000000000099');
});

test('folder-only mkdir produces a zero-payload create commit', () => {
  const value = serializeNamespaceEvent({itemId:'00000000-0000-4000-8000-000000000011',kind:'folder',name:'Empty',parentFolderId:null,mtime:10,parentVersionId:null,operation:'create'});
  assert.deepEqual({kind:value.kind,operation:value.operation,size:value.size,mime:value.mime,sha256:value.sha256,chunks:value.chunks},
    {kind:'folder',operation:'create',size:0,mime:null,sha256:null,chunks:[]});
});

test('folder-only rmdir produces a retained tombstone commit', () => {
  const value = serializeNamespaceEvent({itemId:'00000000-0000-4000-8000-000000000011',kind:'folder',name:'Empty',parentFolderId:null,mtime:11,parentVersionId:'00000000-0000-4000-8000-000000000012',operation:'delete'});
  assert.equal(value.deleted,true); assert.equal(value.operation,'delete'); assert.deepEqual(value.chunks,[]);
});

test('empty-folder rename keeps its stable itemId and produces metadata', () => {
  const value = serializeNamespaceEvent({itemId:'00000000-0000-4000-8000-000000000011',kind:'folder',name:'Renamed',parentFolderId:null,mtime:12,parentVersionId:'00000000-0000-4000-8000-000000000012',operation:'metadata'});
  assert.equal(value.itemId,'00000000-0000-4000-8000-000000000011'); assert.equal(value.operation,'metadata');
});
