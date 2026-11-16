// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

/** A request failure with the HTTP status the Files error handler answers with. */
export class HttpError extends Error { constructor(public readonly status:number, message:string) { super(message) } }
