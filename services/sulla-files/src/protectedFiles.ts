import type pg from 'pg';

export function isProtectedPath(path:string):boolean { return path.replaceAll('\\', '/').split('/').some(part => part.toLowerCase() === 'master.key') }
export function protectedPathError():Error { return Object.assign(new Error('Protected system file'), { status: 403 }) }
export async function assertUnprotectedFile(db:pg.Pool, file:{ id:string; path:string }):Promise<void> {
  if (isProtectedPath(file.path) || (await db.query('SELECT 1 FROM files_protected_files WHERE file_id=$1', [file.id])).rowCount) throw protectedPathError();
}
