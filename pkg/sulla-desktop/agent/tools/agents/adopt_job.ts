// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import { ReassignJobWorker } from './reassign_job';
export class AdoptJobWorker extends ReassignJobWorker {
  protected async _validatedCall(input:any){return super._validatedCall({...input,to:'me'});}
}
