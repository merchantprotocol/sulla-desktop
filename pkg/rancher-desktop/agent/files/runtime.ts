import { FolderChunkStore } from './folderStore';
import { FileKeyring } from './keyring';
import { SullaFilesService } from './service';

let singleton: SullaFilesService | undefined;
let folderStore: FolderChunkStore | undefined;
let keyring: FileKeyring | undefined;
export function getSullaFilesService(): SullaFilesService {
  if (!process.env.SULLA_FILES_CHUNK_ROOT || !process.env.SULLA_FILES_MASTER_KEY_PATH) {
    throw new Error('The retired in-process Files store has no default path; use the authoritative Files container');
  }
  folderStore ??= new FolderChunkStore(process.env.SULLA_FILES_CHUNK_ROOT);
  keyring ??= new FileKeyring(process.env.SULLA_FILES_MASTER_KEY_PATH);
  singleton ??= new SullaFilesService(folderStore, keyring);
  return singleton;
}
export function getSullaFilesRuntime() { getSullaFilesService(); return { store: folderStore!, keyring: keyring!, files: singleton! } }
