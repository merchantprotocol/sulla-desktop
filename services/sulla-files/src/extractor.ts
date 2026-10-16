import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);
const MAX_TEXT = 4 * 1024 * 1024;

export interface ExtractedText { text: string | null; status: 'indexed' | 'unsupported' | 'failed' }

/**
 * All extraction runs in the files service/container. Optional binaries are
 * deliberately discovered at runtime so a minimal Desktop image still syncs
 * files and exposes a clean hook for PDF/Office/OCR/transcript images.
 */
export async function extractIndexText(path: string, mime: string): Promise<ExtractedText> {
  try {
    if (mime.startsWith('text/') || ['application/json', 'application/yaml', 'application/xml'].includes(mime)) {
      const text = (await readFile(path, 'utf8')).slice(0, MAX_TEXT);
      return { text, status: 'indexed' };
    }
    if (mime === 'application/pdf') return commandText('pdftotext', ['-layout', path, '-']);
    if (mime === 'application/msword') return commandText('catdoc', [path]);
    if (mime.includes('wordprocessingml')) return commandText('docx2txt', [path, '-']);
    if (mime === 'application/vnd.ms-excel') return commandText('xls2csv', [path]);
    if (mime === 'application/vnd.ms-powerpoint') return commandText('catppt', [path]);
    if (mime.includes('spreadsheetml')) return ooxmlText(path, 'xl/sharedStrings.xml');
    if (mime.includes('presentationml')) return ooxmlText(path, 'ppt/slides/slide*.xml');
    if (mime.startsWith('image/')) return commandText('tesseract', [path, 'stdout']);
    if (mime.startsWith('audio/') || mime.startsWith('video/')) {
      for (const binary of ['whisper-cli', 'whisper-cpp']) {
        const result = await commandText(binary, ['--file', path]);
        if (result.status !== 'unsupported') return result;
      }
      return { text: null, status: 'unsupported' };
    }
    return { text: null, status: 'unsupported' };
  } catch {
    return { text: null, status: 'failed' };
  }
}

async function ooxmlText(path:string, member:string):Promise<ExtractedText> {
  const result = await commandText('unzip', ['-p', path, member]);
  if (!result.text) return result;
  return { ...result, text: result.text.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim() };
}

async function commandText(binary: string, args: string[]): Promise<ExtractedText> {
  try {
    const result = await run(binary, args, { maxBuffer: MAX_TEXT, timeout: 30_000 });
    return { text: result.stdout.slice(0, MAX_TEXT) || null, status: 'indexed' };
  } catch (error: any) {
    if (error?.code === 'ENOENT') return { text: null, status: 'unsupported' };
    return { text: null, status: 'failed' };
  }
}
