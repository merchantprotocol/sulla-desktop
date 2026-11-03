// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

let timer:ReturnType<typeof setInterval>|null=null;
/** Marketplace/installable projections remain implemented, but are not part of personal sync. */
export async function syncRuntimeProjections(_force=false){ return; }
export const CloudRuntimeProjectionSync={start(){if(timer)return;timer=setInterval(()=>void syncRuntimeProjections(false),60_000);timer.unref?.()},stop(){if(timer)clearInterval(timer);timer=null},changed(){void syncRuntimeProjections(false)}};
