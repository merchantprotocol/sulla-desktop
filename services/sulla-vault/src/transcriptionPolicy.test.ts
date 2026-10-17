import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTranscriptionProviderRequest } from './transcriptionPolicy.js';

test('transcription policy builds bounded multipart with the file field last', () => {
  const result = buildTranscriptionProviderRequest({
    audioBase64: Buffer.from('synthetic-wav').toString('base64'),
    language:    'en-US',
    filename:    'ch0.wav',
  }, { authorization: 'Bearer [synthetic]' });
  const rendered = result.body.toString('utf8');
  assert.equal(result.headers.authorization, 'Bearer [synthetic]');
  assert.match(result.headers['content-type'], /^multipart\/form-data; boundary=sulla-/);
  assert.ok(rendered.indexOf('name="language"') < rendered.indexOf('name="file"'));
  assert.match(rendered, /synthetic-wav/);
});
test('transcription policy rejects malformed audio before outbound request', () => {
  assert.throws(
    () => buildTranscriptionProviderRequest({ audioBase64: 'not base64!', language: 'en' }, {}),
    /invalid_transcription_audio/,
  );
});
