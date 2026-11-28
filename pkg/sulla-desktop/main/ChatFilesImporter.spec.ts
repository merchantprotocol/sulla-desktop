// SPDX-License-Identifier: GPL-2.0-or-later
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ dialog: { showOpenDialog: vi.fn() } }));

import { ChatFilesImporter, type ChatFilesClientPort, type ChatFilesDialogPort } from './ChatFilesImporter.ts';
import { ChatFilesSourceGuard } from './ChatFilesSourceGuard.ts';

interface Upload { path: string; bytes: Buffer; headers: Record<string, string> }
type Responder = (upload:Upload, index:number) => Response;

/** In-memory Files service: lists existing names and records every streamed import. */
class FakeFilesClient implements ChatFilesClientPort {
  readonly uploads:Upload[] = [];
  collections:unknown[] = [{ id: 'col-files', name: 'Files', kind: 'knowledge' }];

  constructor(private readonly existing:{ path: string; trash?: boolean }[] = [], private readonly responder:Responder = FakeFilesClient.commit) {}

  static commit(upload:Upload):Response {
    return Response.json({ id: `file-${ upload.path }`, current_version_id: `v-${ upload.path }`, path: upload.path, size: upload.bytes.length, updated_at: '2026-11-16T00:00:00.000Z' });
  }

  async request(url:string):Promise<Response> {
    const trash = new URL(url, 'http://files.local').searchParams.get('trash') === 'true';
    return Response.json(this.existing.filter(file => Boolean(file.trash) === trash).map(file => ({ path: file.path })));
  }

  async json<T>(endpoint:string):Promise<T> {
    if (endpoint !== '/v1/collections') throw new Error(`unexpected ${ endpoint }`);
    return this.collections as T;
  }

  async stream(endpoint:string, init:RequestInit = {}):Promise<Response> {
    const chunks:Buffer[] = [];
    for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) chunks.push(Buffer.from(chunk));
    const upload = { path: new URL(endpoint, 'http://files.local').searchParams.get('path') ?? '', bytes: Buffer.concat(chunks), headers: init.headers as Record<string, string> };
    this.uploads.push(upload);
    return this.responder(upload, this.uploads.length - 1);
  }
}

const noDialog:ChatFilesDialogPort = { showOpenDialog: vi.fn() } as unknown as ChatFilesDialogPort;

describe('ChatFilesImporter', () => {
  let temporary:string;
  let protectedRoot:string;
  const write = async(name:string, content = 'hello') => {
    const file = path.join(temporary, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  const importer = (client:FakeFilesClient, maxBytes?:number, dialog = noDialog) => new ChatFilesImporter(client, new ChatFilesSourceGuard(() => [protectedRoot, undefined], maxBytes), dialog);

  beforeEach(async() => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'sulla-chat-import-'));
    protectedRoot = path.join(temporary, 'app-home');
    await fs.mkdir(protectedRoot);
  });
  afterEach(async() => { await fs.rm(temporary, { recursive: true, force: true }) });

  it('streams the exact source bytes and returns a durable version reference', async() => {
    // risk: data integrity — the attached reference must name the committed version of the exact bytes chosen.
    const source = await write('report.pdf', 'pdf-bytes');
    const client = new FakeFilesClient();
    const result = await importer(client).import([source], '/Docs/');
    expect(client.uploads).toHaveLength(1);
    expect(client.uploads[0].bytes.toString()).toBe('pdf-bytes');
    expect(client.uploads[0].headers).toMatchObject({ 'content-type': 'application/pdf', 'x-sulla-expected-bytes': '9' });
    expect(result).toEqual([expect.objectContaining({ fileId: 'file-Docs/report.pdf', versionId: 'v-Docs/report.pdf', path: 'Docs/report.pdf', name: 'report.pdf', mime: 'application/pdf', size: 9, collectionId: 'col-files' })]);
    expect(await fs.readFile(source, 'utf8')).toBe('pdf-bytes');
  });

  it('never overwrites an existing or trashed name and retries after a conflict', async() => {
    // risk: data loss — an import must not replace an existing Files document with the same name.
    const source = await write('notes.txt');
    const client = new FakeFilesClient(
      [{ path: 'Docs/notes.txt' }, { path: 'Docs/notes (1).txt', trash: true }, { path: 'Docs/deeper/notes (2).txt' }],
      (upload, index) => index === 0 ? new Response('{}', { status: 409 }) : FakeFilesClient.commit(upload),
    );
    const result = await importer(client).import([source], 'Docs');
    expect(client.uploads.map(upload => upload.path)).toEqual(['Docs/notes (2).txt', 'Docs/notes (3).txt']);
    expect(result).toEqual([expect.objectContaining({ path: 'Docs/notes (3).txt' })]);
  });

  it('gives two selected files with the same name distinct destinations', async() => {
    // risk: data loss — two sources with one name must not collapse into one Files document.
    const first = await write('a/photo.png', 'one');
    const second = await write('b/photo.png', 'two');
    const client = new FakeFilesClient();
    const result = await importer(client).import([first, second]);
    expect(client.uploads.map(upload => [upload.path, upload.bytes.toString()])).toEqual([['photo.png', 'one'], ['photo (1).png', 'two']]);
    expect(result).toHaveLength(2);
  });

  it('reports the committed files when a later file fails', async() => {
    // risk: data integrity — files already committed must still be attachable and the failure surfaced.
    const first = await write('one.txt');
    const second = await write('two.txt');
    const client = new FakeFilesClient([], (upload, index) => index === 1 ? Response.json({ error: 'Files storage is full.' }, { status: 507 }) : FakeFilesClient.commit(upload));
    const result = await importer(client).import([first, second]);
    expect(result).toEqual({
      references: [expect.objectContaining({ path: 'one.txt' })],
      error:      'Files storage is full. The files already listed were imported and are ready to attach.',
    });
  });

  it('throws when the first file fails so nothing is reported as attached', async() => {
    // risk: data integrity — a failed import must not return an empty success.
    const source = await write('one.txt');
    const client = new FakeFilesClient([], () => new Response('not json', { status: 500 }));
    await expect(importer(client).import([source])).rejects.toThrow('Files import failed (500)');
  });

  it('refuses a commit whose path or size Files did not confirm', async() => {
    // risk: data integrity — a reference must only be returned for the version that holds these bytes.
    const source = await write('one.txt', 'abc');
    const client = new FakeFilesClient([], upload => Response.json({ id: 'f', current_version_id: 'v', path: upload.path, size: 2 }));
    await expect(importer(client).import([source])).rejects.toThrow('Files did not confirm the imported file version.');
  });

  it('enforces the selection count before touching Files', async() => {
    // risk: resource exhaustion — oversized selections must be refused without any upload.
    const client = new FakeFilesClient();
    await expect(importer(client).import(Array.from({ length: 101 }, (_, index) => `/tmp/${ index }`))).rejects.toThrow('Choose 100 files or fewer at a time.');
    await expect(importer(client).import([''])).rejects.toThrow('Files import requires selected file paths.');
    expect(await importer(client).import([])).toEqual([]);
    expect(client.uploads).toHaveLength(0);
  });

  it('validates every source before the first upload', async() => {
    // risk: resource exhaustion and partial writes — one oversized file must stop the whole batch before any commit.
    const small = await write('small.txt', 'ok');
    const large = await write('large.bin', 'too large');
    const client = new FakeFilesClient();
    await expect(importer(client, 4).import([small, large])).rejects.toThrow('This file is too large to import into Files.');
    expect(client.uploads).toHaveLength(0);
  });

  it('refuses protected application paths, secrets and symlinks into them', async() => {
    // risk: secret exfiltration — credentials and app data must never be copied into Files.
    const client = new FakeFilesClient();
    const appFile = path.join(protectedRoot, 'settings.json');
    await fs.writeFile(appFile, '{}');
    const link = path.join(temporary, 'innocent.json');
    await fs.symlink(appFile, link);
    await expect(importer(client).import([appFile])).rejects.toThrow('That protected application file cannot be imported.');
    await expect(importer(client).import([link])).rejects.toThrow('That protected application file cannot be imported.');
    await expect(importer(client).import([await write('.env')])).rejects.toThrow('That protected source cannot be imported.');
    await expect(importer(client).import([await write('.ssh/id_rsa')])).rejects.toThrow('That protected source cannot be imported.');
    await expect(importer(client).import([await write('server.pem')])).rejects.toThrow('That protected source cannot be imported.');
    await expect(importer(client).import([await write('my-wallet-backup/readme.txt')])).rejects.toThrow('That protected source cannot be imported.');
    expect(client.uploads).toHaveLength(0);
  });

  it('rejects a missing source, a directory and a traversing destination', async() => {
    // risk: file access control — only regular files go in, and only inside the chosen Files folder.
    const client = new FakeFilesClient();
    await expect(importer(client).import([path.join(temporary, 'gone.txt')])).rejects.toThrow('The selected source is no longer available.');
    await expect(importer(client).import([temporary])).rejects.toThrow('The selected source changed before Files could open it.');
    await expect(importer(client).import([await write('one.txt')], 'Docs/../Other')).rejects.toThrow('The Files destination is invalid.');
    expect(client.uploads).toHaveLength(0);
  });

  it('fails when the Files collection is unavailable', async() => {
    // risk: data integrity — files must never be written to a legacy or unknown collection.
    const client = new FakeFilesClient();
    client.collections = [{ id: 'old', name: 'Files', compatibility_state: 'legacy' }];
    await expect(importer(client).import([await write('one.txt')])).rejects.toThrow('The authenticated Files collection is unavailable.');
  });

  it('returns nothing when the picker is cancelled and imports what was picked', async() => {
    // risk: irreversible side effect — a cancelled picker must not import anything.
    const source = await write('picked.md');
    const showOpenDialog = vi.fn()
      .mockResolvedValueOnce({ canceled: true, filePaths: [source] })
      .mockResolvedValueOnce({ canceled: false, filePaths: [source] });
    const client = new FakeFilesClient();
    const subject = importer(client, undefined, { showOpenDialog } as unknown as ChatFilesDialogPort);
    expect(await subject.pickAndImport()).toEqual([]);
    expect(await subject.pickAndImport()).toEqual([expect.objectContaining({ path: 'picked.md', mime: 'text/markdown' })]);
    expect(client.uploads).toHaveLength(1);
  });
});
