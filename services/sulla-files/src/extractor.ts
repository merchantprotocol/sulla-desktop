import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_TEXT = 4 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 512 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_MEDIA_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PDF_OCR_PAGES = 20;

export type IndexOutcome = 'indexed' | 'unsupported' | 'failed';
export interface ExtractedText { text: string | null; status: IndexOutcome; reasonCode: string; reason: string }

function outcome(status:IndexOutcome, text:string | null, reasonCode:string, reason:string):ExtractedText {
  return { status, text: text?.slice(0, MAX_TEXT) || null, reasonCode, reason };
}

function decodeXml(value:string):string {
  return value.replace(/&#(x?[0-9a-f]+);/gi, (_match, code:string) => String.fromCodePoint(Number.parseInt(code.replace(/^x/i, ''), code.startsWith('x') ? 16 : 10)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

function structuredXml(xml:string, kind:'document' | 'sheet' | 'slides'):string {
  let value = xml;
  if (kind === 'document') value = value.replace(/<w:tab\b[^>]*\/>/g, '\t').replace(/<w:br\b[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tr>/g, '\n');
  if (kind === 'sheet') value = value.replace(/<\/c>/g, '\t').replace(/<\/row>/g, '\n').replace(/<\/si>/g, '\n');
  if (kind === 'slides') value = value.replace(/<a:br\b[^>]*\/>/g, '\n').replace(/<\/a:p>/g, '\n').replace(/<\/p:sld>/g, '\n\n');
  return decodeXml(value.replace(/<[^>]+>/g, '')).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
}

async function command(binary:string, args:string[], timeout = 30_000):Promise<{ stdout:string; missing?:boolean; error?:string }> {
  try {
    const result = await run(binary, args, { encoding: 'utf8', maxBuffer: MAX_TEXT, timeout });
    return { stdout: result.stdout };
  } catch (error:any) {
    if (error?.code === 'ENOENT') return { stdout: '', missing: true };
    return { stdout: '', error: typeof error?.message === 'string' ? error.message : 'extractor command failed' };
  }
}

async function commandText(binary:string, args:string[], successCode:string, successReason:string, timeout = 30_000):Promise<ExtractedText> {
  const result = await command(binary, args, timeout);
  if (result.missing) return outcome('failed', null, 'runtime_missing', `${ binary } is not installed in the Files runtime.`);
  if (result.error) return outcome('failed', null, 'extractor_error', `${ binary } could not read this file.`);
  return outcome('indexed', result.stdout, successCode, successReason);
}

async function ooxmlText(path:string, kind:'document' | 'sheet' | 'slides'):Promise<ExtractedText> {
  const listing = await command('unzip', ['-Z1', path]);
  if (listing.missing) return outcome('failed', null, 'office_runtime_missing', 'Office extraction is unavailable in this Files runtime.');
  if (listing.error) return outcome('failed', null, 'office_corrupt', 'The Office document could not be opened.');
  const members = listing.stdout.split('\n').filter(member => kind === 'document'
    ? member === 'word/document.xml'
    : kind === 'sheet'
      ? member === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+[.]xml$/.test(member)
      : /^ppt\/slides\/slide\d+[.]xml$/.test(member)).slice(0, 1_000);
  if (!members.length) return outcome('failed', null, 'office_structure_missing', 'The Office document does not contain readable document parts.');
  const parts:string[] = [];
  for (const member of members) {
    const result = await command('unzip', ['-p', path, member]);
    if (result.error || result.missing) return outcome('failed', null, 'office_corrupt', 'An Office document part could not be opened.');
    parts.push(structuredXml(result.stdout, kind));
    if (parts.reduce((size, part) => size + part.length, 0) >= MAX_TEXT) break;
  }
  return outcome('indexed', parts.filter(Boolean).join('\n\n'), 'office_extracted', 'Office document structure and text indexed locally.');
}

async function imageOcr(path:string):Promise<ExtractedText> {
  if ((await stat(path)).size > MAX_IMAGE_BYTES) return outcome('unsupported', null, 'image_too_large', 'Image OCR supports files up to 64 MB.');
  return commandText('tesseract', [path, 'stdout', '-l', 'eng'], 'image_ocr', 'Image text indexed with local OCR.', 120_000);
}

async function pdfText(path:string):Promise<ExtractedText> {
  const direct = await command('pdftotext', ['-layout', path, '-'], 60_000);
  if (direct.missing) return outcome('failed', null, 'pdf_runtime_missing', 'PDF extraction is unavailable in this Files runtime.');
  if (direct.error) return outcome('failed', null, 'pdf_corrupt', 'The PDF could not be opened.');
  if (direct.stdout.replace(/\s/g, '').length >= 24) return outcome('indexed', direct.stdout, 'pdf_text', 'PDF text and layout indexed locally.');

  const temp = await mkdtemp(join(tmpdir(), 'sulla-files-pdf-ocr-'));
  try {
    const rendered = await command('pdftoppm', ['-f', '1', '-l', String(MAX_PDF_OCR_PAGES), '-r', '150', '-png', path, join(temp, 'page')], 180_000);
    if (rendered.missing) return outcome('failed', null, 'pdf_ocr_runtime_missing', 'Scanned PDF OCR is unavailable in this Files runtime.');
    if (rendered.error) return outcome('failed', null, 'pdf_ocr_render_failed', 'The scanned PDF could not be prepared for OCR.');
    const pages = (await readdir(temp)).filter(name => name.endsWith('.png')).sort();
    const text:string[] = [];
    for (const page of pages) {
      const ocr = await command('tesseract', [join(temp, page), 'stdout', '-l', 'eng'], 120_000);
      if (ocr.missing) return outcome('failed', null, 'pdf_ocr_runtime_missing', 'Scanned PDF OCR is unavailable in this Files runtime.');
      if (ocr.error) return outcome('failed', null, 'pdf_ocr_failed', 'A scanned PDF page could not be read by OCR.');
      if (ocr.stdout.trim()) text.push(ocr.stdout.trim());
    }
    const suffix = pages.length === MAX_PDF_OCR_PAGES ? ` Only the first ${ MAX_PDF_OCR_PAGES } pages were indexed.` : '';
    return outcome('indexed', text.join('\n\n'), 'pdf_ocr', `Scanned PDF text indexed with local OCR.${ suffix }`);
  } finally { await rm(temp, { recursive: true, force: true }) }
}

async function mediaTranscript(path:string):Promise<ExtractedText> {
  if ((await stat(path)).size > MAX_MEDIA_BYTES) return outcome('unsupported', null, 'media_too_large', 'Audio and video transcription supports files up to 2 GB.');
  const temp = await mkdtemp(join(tmpdir(), 'sulla-files-media-'));
  try {
    const wav = join(temp, 'audio.wav');
    const decoded = await command('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', path, '-t', '7200', '-ar', '16000', '-ac', '1', wav], 30 * 60_000);
    if (decoded.missing) return outcome('failed', null, 'media_decode_runtime_missing', 'Media decoding is unavailable in this Files runtime.');
    if (decoded.error) return outcome('failed', null, 'media_decode_failed', 'The audio track could not be decoded.');
    const stem = join(temp, 'transcript');
    const transcript = await command('/usr/local/bin/whisper-cli', ['-m', '/app/models/ggml-tiny-q5_1.bin', '-f', wav, '-otxt', '-of', stem, '-t', '2', '-np'], 2 * 60 * 60_000);
    if (transcript.missing) return outcome('failed', null, 'transcription_runtime_missing', 'The bundled local transcription runtime is unavailable.');
    if (transcript.error) return outcome('failed', null, 'transcription_failed', 'Local transcription could not process this media file.');
    return outcome('indexed', await readFile(`${ stem }.txt`, 'utf8'), 'media_transcribed', 'Audio indexed with the bundled local Whisper model.');
  } finally { await rm(temp, { recursive: true, force: true }) }
}

/** Extracts current-version content locally with explicit resource bounds and outcomes. */
export async function extractIndexText(path:string, mime:string):Promise<ExtractedText> {
  try {
    const size = (await stat(path)).size;
    if (size > MAX_DOCUMENT_BYTES && !mime.startsWith('audio/') && !mime.startsWith('video/')) {
      return outcome('unsupported', null, 'document_too_large', 'Text, PDF, Office, and image indexing supports files up to 512 MB.');
    }
    if (mime.startsWith('text/') || ['application/json', 'application/yaml', 'application/xml'].includes(mime)) {
      return outcome('indexed', (await readFile(path, 'utf8')).slice(0, MAX_TEXT), 'text_extracted', 'Text indexed locally.');
    }
    if (mime === 'application/pdf') return pdfText(path);
    if (mime === 'application/msword') return commandText('antiword', [path], 'word_extracted', 'Word document text indexed locally.');
    if (mime.includes('wordprocessingml')) return ooxmlText(path, 'document');
    if (mime.includes('spreadsheetml')) return ooxmlText(path, 'sheet');
    if (mime.includes('presentationml')) return ooxmlText(path, 'slides');
    if (mime.startsWith('image/')) return imageOcr(path);
    if (mime.startsWith('audio/') || mime.startsWith('video/')) return mediaTranscript(path);
    return outcome('unsupported', null, 'format_unsupported', `This file type (${ mime || 'unknown' }) does not have a local text extractor.`);
  } catch {
    return outcome('failed', null, 'extractor_failed', 'The local extractor could not read this file safely.');
  }
}
