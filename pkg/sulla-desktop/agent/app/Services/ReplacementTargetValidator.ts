// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later

import {modelRouter} from '../../languagemodels/modelRouter';
import {resolveRoutableAgent} from '../../services/ChatAgentRouting';

export interface ReplacementTargetValidationPort { validate(agentId:string,model?:string,provider?:string):Promise<void> }

/** Uses the same production identity and model routing catalogs as spawn_agent. */
export class ReplacementTargetValidator implements ReplacementTargetValidationPort {
  constructor(private readonly resolveAgent=resolveRoutableAgent,private readonly resolveModel=modelRouter.resolve.bind(modelRouter)){}
  async validate(agentId:string,model?:string,provider?:string):Promise<void>{
    if(!await this.resolveAgent(agentId))throw new Error(`Agent "${agentId}" does not have an enabled agent definition.`);
    if(!model&&!provider)return;
    const candidate=(await this.resolveModel('agents',{mode:'pin',provider:provider?.trim()||undefined,model:model?.trim()||undefined} as any))[0];
    if(!candidate||provider&&candidate.provider!==provider||model&&candidate.model!==model)throw new Error(`Model route "${provider??'*'}/${model??'*'}" is not available.`);
  }
}
