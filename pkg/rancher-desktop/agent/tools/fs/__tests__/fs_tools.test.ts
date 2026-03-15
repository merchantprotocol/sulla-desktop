import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from '@jest/globals';

import { CreateWorkspaceWorker, createWorkspaceRegistration } from '../../workspace/create_workspace';
import { FsMkdirWorker, fsMkdirRegistration } from '../mkdir';
import { FsWriteFileWorker, fsWriteFileRegistration } from '../write_file';
import { FsReadFileWorker, fsReadFileRegistration } from '../read_file';
import { FsAppendFileWorker, fsAppendFileRegistration } from '../append_file';
import { FsListDirWorker, fsListDirRegistration } from '../list_dir';
import { FsDeletePathWorker, fsDeletePathRegistration } from '../delete_path';
import { FsCopyPathWorker, fsCopyPathRegistration } from '../copy_path';
import { FsMovePathWorker, fsMovePathRegistration } from '../move_path';
import { FsPathInfoWorker, fsPathInfoRegistration } from '../path_info';

function configureWorker<T extends { name: string; description: string; schemaDef: any }>(
  worker: T,
  registration: { name: string; description: string; schemaDef: any },
): T {
  worker.name = registration.name;
  worker.description = registration.description;
  worker.schemaDef = registration.schemaDef;
  return worker;
}

describe('fs tool category', () => {
  it('manages files end-to-end in a created workspace (mkdir, write, append, copy, move, list, info, delete)', async() => {
    const workspaceName = `jest-fs-workspace-${ Date.now() }`;
    const workspaceRoot = path.join(
      os.homedir(),
      'workspaces',
      workspaceName,
    );
    const projectDir = path.join(workspaceRoot, 'project');
    const docsDir = path.join(projectDir, 'docs');
    const guidesDir = path.join(docsDir, 'guides');
    const archiveDir = path.join(projectDir, 'archive');
    const filePath = path.join(docsDir, 'notes.txt');
    const nestedFilePath = path.join(guidesDir, 'guide.txt');
    const copiedPath = path.join(archiveDir, 'notes-copy.txt');
    const movedPath = path.join(archiveDir, 'notes-final.txt');

    const createWorkspaceWorker = configureWorker(new CreateWorkspaceWorker(), createWorkspaceRegistration);

    const mkdirWorker = configureWorker(new FsMkdirWorker(), fsMkdirRegistration);
    const writeWorker = configureWorker(new FsWriteFileWorker(), fsWriteFileRegistration);
    const readWorker = configureWorker(new FsReadFileWorker(), fsReadFileRegistration);
    const appendWorker = configureWorker(new FsAppendFileWorker(), fsAppendFileRegistration);
    const listWorker = configureWorker(new FsListDirWorker(), fsListDirRegistration);
    const infoWorker = configureWorker(new FsPathInfoWorker(), fsPathInfoRegistration);
    const deleteWorker = configureWorker(new FsDeletePathWorker(), fsDeletePathRegistration);
    const copyWorker = configureWorker(new FsCopyPathWorker(), fsCopyPathRegistration);
    const moveWorker = configureWorker(new FsMovePathWorker(), fsMovePathRegistration);

    const createWorkspaceResult = await createWorkspaceWorker.invoke({ name: workspaceName });
    expect(createWorkspaceResult.success).toBe(true);
    expect(createWorkspaceResult.result).toContain(`workspaces/${ workspaceName }`);
    expect(fs.existsSync(workspaceRoot)).toBe(true);

    const mkdirResult = await mkdirWorker.invoke({ path: docsDir });
    expect(mkdirResult.success).toBe(true);

    const mkdirGuidesResult = await mkdirWorker.invoke({ path: guidesDir });
    expect(mkdirGuidesResult.success).toBe(true);

    const mkdirArchiveResult = await mkdirWorker.invoke({ path: archiveDir });
    expect(mkdirArchiveResult.success).toBe(true);

    const writeResult = await writeWorker.invoke({ path: filePath, content: 'hello fs tools' });
    expect(writeResult.success).toBe(true);

    const nestedWriteResult = await writeWorker.invoke({ path: nestedFilePath, content: 'nested guide' });
    expect(nestedWriteResult.success).toBe(true);

    const appendResult = await appendWorker.invoke({ path: filePath, content: '\nappended line' });
    expect(appendResult.success).toBe(true);

    const readResult = await readWorker.invoke({ path: filePath });
    expect(readResult.success).toBe(true);
    expect(readResult.result).toBe('hello fs tools\nappended line');

    const copyResult = await copyWorker.invoke({ sourcePath: filePath, destinationPath: copiedPath, overwrite: true });
    expect(copyResult.success).toBe(true);

    const moveResult = await moveWorker.invoke({ sourcePath: copiedPath, destinationPath: movedPath });
    expect(moveResult.success).toBe(true);

    const movedReadResult = await readWorker.invoke({ path: movedPath });
    expect(movedReadResult.success).toBe(true);
    expect(movedReadResult.result).toBe('hello fs tools\nappended line');

    const listResult = await listWorker.invoke({ path: docsDir });
    expect(listResult.success).toBe(true);
    expect(listResult.result).toContain('notes.txt');
    expect(listResult.result).toContain('guides');
    expect(listResult.result).not.toContain('guides/guide.txt');

    const listDepthTwoResult = await listWorker.invoke({ path: docsDir, depth: 2 });
    expect(listDepthTwoResult.success).toBe(true);
    expect(listDepthTwoResult.result).toContain('guides/guide.txt');

    const listArchiveResult = await listWorker.invoke({ path: archiveDir });
    expect(listArchiveResult.success).toBe(true);
    expect(listArchiveResult.result).toContain('notes-final.txt');

    const infoResult = await infoWorker.invoke({ path: movedPath });
    expect(infoResult.success).toBe(true);
    expect(infoResult.result).toContain('"exists": true');
    expect(infoResult.result).toContain('"type": "file"');

    const deleteResult = await deleteWorker.invoke({ path: workspaceRoot, recursive: true, force: true });
    expect(deleteResult.success).toBe(true);
    expect(fs.existsSync(workspaceRoot)).toBe(false);
  });
});
