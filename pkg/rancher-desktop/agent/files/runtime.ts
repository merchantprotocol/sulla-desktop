import { homedir } from 'node:os';
import { join } from 'node:path';

import { FolderChunkStore } from './folderStore';
import { FileKeyring } from './keyring';
import { SullaFilesService } from './service';

let singleton: SullaFilesService | undefined;
let folderStore: FolderChunkStore | undefined;
let keyring: FileKeyring | undefined;
export function getSullaFilesService(): SullaFilesService {
  folderStore ??= new FolderChunkStore(process.env.SULLA_FILES_CHUNK_ROOT ?? join(homedir(), 'sulla/files/chunks'));
  keyring ??= new FileKeyring(process.env.SULLA_FILES_MASTER_KEY_PATH ?? join(homedir(), 'sulla/files/master.key'));
  singleton ??= new SullaFilesService(folderStore, keyring);
  return singleton;
}
export function getSullaFilesRuntime() { getSullaFilesService(); return { store: folderStore!, keyring: keyring!, files: singleton! } }
