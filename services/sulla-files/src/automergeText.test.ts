import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeTextDocuments } from './automergeText.js';

test('stale branches retain independent edits and same-line conflicts remain valid',()=>{
  const distinct=mergeTextDocuments('one\ntwo\nthree\n','ONE\ntwo\nthree\n','one\ntwo\nTHREE\n');
  assert.match(distinct.text,/ONE/); assert.match(distinct.text,/THREE/);
  const conflicting=mergeTextDocuments('same\n','left\n','right\n');
  assert.equal(typeof conflicting.text,'string'); assert.ok(conflicting.text.length>0);
});
