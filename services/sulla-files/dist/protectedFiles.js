export function isProtectedPath(path) {
    return path.replaceAll('\\', '/').split('/').some(part => {
        const value = part.toLowerCase();
        return value === 'master.key' || value.includes('wallet') || value === 'vault' || value === 'vaults';
    });
}
export function protectedPathError() { return Object.assign(new Error('Protected system file'), { status: 403 }); }
export function isAuditLogPath(path) { return /^audit\/(files|vault)\/[A-Za-z0-9_-]+\.jsonl$/.test(path); }
export async function assertUnprotectedFile(db, file) {
    const systemLog = isAuditLogPath(file.path) && Boolean((await db.query("SELECT 1 FROM files f JOIN collections c ON c.id=f.collection_id WHERE f.id=$1 AND c.system_area='logs'", [file.id])).rowCount);
    if ((isProtectedPath(file.path) && !systemLog) || (await db.query('SELECT 1 FROM files_protected_files WHERE file_id=$1', [file.id])).rowCount)
        throw protectedPathError();
}
