// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

export interface FilesEscrowTransport {format:'sulla-files-sync-transport';v:1;alg:'ECDH-P256+HKDF-SHA256+A256GCM';epk:string;nonce:string;ct:string}
export class FilesCloudEscrowError extends Error { constructor(readonly code:string,readonly status:number,message?:string){super(message||code)} }
