export class StoredNamespaceConflict extends Error {
    status = 409;
}
export function storedParentPaths(path) {
    const parts = path.split('/');
    return parts.slice(0, -1).map((_part, index) => parts.slice(0, index + 1).join('/'));
}
function creator(actor) {
    return [actor.kind === 'capability' ? 'agent-or-device' : 'user', actor.userId];
}
/**
 * Every stored namespace mutation takes this transaction-scoped collection
 * lock before any file/folder row lock. PostgreSQL cannot express the
 * file-versus-folder prefix invariant as a normal unique constraint, so the
 * shared lock is the serialization point for checking and changing paths.
 */
export async function lockStoredNamespace(client, collectionId) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`stored-namespace:${collectionId}`]);
}
export async function assertStoredFilePath(client, collectionId, path, sameFileId) {
    const parents = storedParentPaths(path);
    const file = await client.query(`SELECT path FROM files
    WHERE collection_id=$1 AND (path=$2 OR path=ANY($3::text[]) OR starts_with(path,$2||'/'))
      AND ($4::uuid IS NULL OR id<>$4::uuid)
    ORDER BY length(path),path LIMIT 1`, [collectionId, path, parents, sameFileId ?? null]);
    if (file.rowCount)
        throw new StoredNamespaceConflict(`A file already occupies ${file.rows[0].path}, so ${path} cannot be stored there.`);
    const folder = await client.query('SELECT path FROM file_folders WHERE collection_id=$1 AND path=$2 LIMIT 1', [collectionId, path]);
    if (folder.rowCount)
        throw new StoredNamespaceConflict(`A folder already exists at ${path}.`);
}
export async function assertStoredFolderPath(client, collectionId, path) {
    const prefixes = [...storedParentPaths(path), path];
    const file = await client.query(`SELECT path FROM files
    WHERE collection_id=$1 AND path=ANY($2::text[])
    ORDER BY length(path),path LIMIT 1`, [collectionId, prefixes]);
    if (file.rowCount)
        throw new StoredNamespaceConflict(`A file already occupies ${file.rows[0].path}, so ${path} cannot be a folder.`);
}
export async function ensureStoredFileParents(client, collectionId, filePath, actor) {
    const [createdByType, createdById] = creator(actor);
    for (const path of storedParentPaths(filePath)) {
        await client.query(`INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(collection_id,path) DO NOTHING`, [collectionId, path, createdByType, createdById]);
    }
}
export async function ensureStoredFolder(client, collectionId, folderPath, actor) {
    await assertStoredFolderPath(client, collectionId, folderPath);
    const [createdByType, createdById] = creator(actor);
    for (const path of [...storedParentPaths(folderPath), folderPath]) {
        await client.query(`INSERT INTO file_folders(collection_id,path,created_by_type,created_by_id)
      VALUES($1,$2,$3,$4) ON CONFLICT(collection_id,path) DO NOTHING`, [collectionId, path, createdByType, createdById]);
    }
}
