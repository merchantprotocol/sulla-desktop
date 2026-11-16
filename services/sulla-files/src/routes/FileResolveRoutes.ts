// Sulla Desktop · https://sulladesktop.com
// Copyright (c) 2025-2026 Merchant Protocol LLC.
// SPDX-License-Identifier: GPL-2.0-or-later
// "Sulla" is a trademark. See TRADEMARK.md.

import type express from 'express';

import { FilesPathResolver } from '../filesPathResolver.js';
import type { FilesAccessGate, RequestWithIdentity } from '../Http/FilesAccessGate.js';
import { FilesRequestInput } from '../Http/FilesRequestInput.js';
import { HttpError } from '../Http/HttpError.js';
import type { FileLocatorRepository } from '../Repositories/FileLocatorRepository.js';

/** GET /v1/files/resolve: maps a /mnt/sulla-files absolute path to the file or folder the caller can view. */
export class FileResolveRoutes {
  constructor(private readonly access:FilesAccessGate, private readonly locator:FileLocatorRepository, private readonly resolver = new FilesPathResolver()) {}

  register(app:express.Express):void {
    app.get('/v1/files/resolve',async(request:RequestWithIdentity,response,next)=>{try{
      this.access.identity(request); const absolute=String(request.query.path??''); const prefix='/mnt/sulla-files/';
      if(!absolute.startsWith(prefix)) throw new HttpError(400,'path must be under /mnt/sulla-files');
      const relative=FilesRequestInput.cleanPath(absolute.slice(prefix.length),false);
      const collections=await this.locator.publishedCollections();
      for (const candidate of this.resolver.candidates(collections,relative)) {
        const fileId=candidate.path?await this.locator.liveFileId(candidate.collectionId,candidate.path):undefined;
        const folderExists=!candidate.path||await this.locator.liveFolderExists(candidate.collectionId,candidate.path);
        if (!fileId && !folderExists) continue;
        try { await this.access.requirePath(request,candidate.collectionId,candidate.path,'view'); } catch (error) { if (error instanceof HttpError && (error.status===403 || error.status===404)) continue; throw error; } // skip collections the caller cannot view; never reveal them
        if(fileId) return response.json({collectionId:candidate.collectionId,fileId,folderPath:candidate.path.includes('/')?candidate.path.slice(0,candidate.path.lastIndexOf('/')):'',kind:'file'});
        return response.json({collectionId:candidate.collectionId,folderPath:candidate.path,kind:'folder'});
      }
      throw new HttpError(404,'Files path not found');
    }catch(error){next(error)}});
  }
}
