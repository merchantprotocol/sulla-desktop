import { createHash } from 'node:crypto';
function canonical(value) {
    if (value === null || typeof value !== 'object')
        return JSON.stringify(value) ?? 'null';
    if (Array.isArray(value))
        return `[${value.map(canonical).join(',')}]`;
    const object = value;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`;
}
export function appendAuditLine(input, previous, now = new Date().toISOString()) {
    const withoutHash = { ts: now, actor: input.actor, action: input.action, subjectKind: input.subjectKind, subjectId: input.subjectId,
        path: input.path ?? '', result: input.result, requestId: input.requestId ?? '', ...(input.meta ? { meta: input.meta } : {}), prevHash: previous?.hash ?? '' };
    return { ...withoutHash, hash: createHash('sha256').update(withoutHash.prevHash + canonical(withoutHash)).digest('hex') };
}
