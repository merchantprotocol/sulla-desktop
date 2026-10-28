// SPDX-License-Identifier: GPL-2.0-or-later
// A cancellation request may arrive while the item holds its transaction's
// batch-row lock. This cooperative signal stops publication between leaves;
// the durable cancelled flag is written once rollback releases that lock.
const requested = new Set();
export const requestOperationCancellation = (id) => { requested.add(id); };
export const clearOperationCancellation = (id) => { requested.delete(id); };
export const assertOperationNotCancelled = (id) => {
    if (requested.has(id))
        throw Object.assign(new Error('Operation cancelled between leaves'), { status: 409, code: 'operation-cancelled' });
};
