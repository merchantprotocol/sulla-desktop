// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import paths from '@pkg/utils/paths';

const enrolledFile=path.join(paths.sullaConfig,'device-id');
const fallbackFile=()=>path.join(app.getPath('userData'),'support-device-id');
export function readEnrolledSupportDeviceId():string|null { try { const id=fs.readFileSync(enrolledFile,'utf8').trim(); return id||null } catch { return null } }
export function readSupportDeviceId():string|null { for(const file of [enrolledFile,fallbackFile()])try{const id=fs.readFileSync(file,'utf8').trim();if(id)return id}catch{} return null }
export function getOrCreateSupportDeviceId():string { const existing=readSupportDeviceId();if(existing)return existing;const id=crypto.randomUUID();fs.mkdirSync(path.dirname(fallbackFile()),{recursive:true});fs.writeFileSync(fallbackFile(),id,{mode:0o600});return id }
