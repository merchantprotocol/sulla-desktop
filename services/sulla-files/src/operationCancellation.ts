// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

// A cancellation request may arrive while the item holds its transaction's
// batch-row lock. This cooperative signal stops publication between leaves;
// the durable cancelled flag is written once rollback releases that lock.
const requested=new Set<string>();
export const requestOperationCancellation=(id:string):void=>{ requested.add(id) };
export const clearOperationCancellation=(id:string):void=>{ requested.delete(id) };
export const assertOperationNotCancelled=(id:string):void=>{
  if (requested.has(id)) throw Object.assign(new Error('Operation cancelled between leaves'),{status:409,code:'operation-cancelled'});
};
