import { randomBytes } from 'node:crypto';

const MAX_TRANSCRIPTION_BYTES = 16 * 1024 * 1024;
const LANGUAGE_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/;

export interface TranscriptionGatewayBody {
  audioBase64: string;
  language:    string;
  filename?:   string;
}
export interface TranscriptionProviderRequest {
  body:    Buffer;
  headers: Record<string, string>;
}

function decodeCanonicalBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || value.length > Math.ceil(MAX_TRANSCRIPTION_BYTES / 3) * 4 + 4) {
    throw new Error('invalid_transcription_audio');
  }
  const normalized = value.replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('invalid_transcription_audio');
  const decoded = Buffer.from(value, 'base64');
  if (!decoded.length || decoded.byteLength > MAX_TRANSCRIPTION_BYTES || decoded.toString('base64').replace(/=+$/, '') !== normalized) {
    decoded.fill(0);
    throw new Error('invalid_transcription_audio');
  }
  return decoded;
}

/** Build xAI multipart inside the credential-owning service, with file last. */
export function buildTranscriptionProviderRequest(
  body: unknown,
  headers: Record<string, string>,
): TranscriptionProviderRequest {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('invalid_transcription_body');
  const input = body as Partial<TranscriptionGatewayBody>;
  const language = typeof input.language === 'string' ? input.language.trim() : '';
  if (!LANGUAGE_PATTERN.test(language)) throw new Error('invalid_transcription_language');
  const requestedName = typeof input.filename === 'string' ? input.filename.trim() : 'audio.wav';
  const filename = /^[A-Za-z0-9._-]{1,80}$/.test(requestedName) ? requestedName : 'audio.wav';
  const audio = decodeCanonicalBase64(input.audioBase64);
  const boundary = `sulla-${ randomBytes(18).toString('hex') }`;
  const prefix = Buffer.from(
    `--${ boundary }\r\nContent-Disposition: form-data; name="language"\r\n\r\n${ language }\r\n` +
    `--${ boundary }\r\nContent-Disposition: form-data; name="file"; filename="${ filename }"\r\n` +
    'Content-Type: audio/wav\r\n\r\n',
    'utf8',
  );
  const suffix = Buffer.from(`\r\n--${ boundary }--\r\n`, 'utf8');
  const multipart = Buffer.concat([prefix, audio, suffix]);
  audio.fill(0);
  const nextHeaders = { ...headers };
  for (const name of Object.keys(nextHeaders)) {
    if (name.toLowerCase() === 'content-type' || name.toLowerCase() === 'content-length') delete nextHeaders[name];
  }
  nextHeaders['content-type'] = `multipart/form-data; boundary=${ boundary }`;
  nextHeaders['content-length'] = String(multipart.byteLength);
  return { body: multipart, headers: nextHeaders };
}
