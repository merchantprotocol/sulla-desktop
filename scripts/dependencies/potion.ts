import fs from 'fs';
import os from 'os';
import path from 'path';

import { convertSafetensorsToInt8 } from './potion-convert';

import { Dependency, DownloadContext } from 'scripts/lib/dependencies';
import { download } from 'scripts/lib/download';

/**
 * minishlab/potion-retrieval-32M — MIT-licensed static embedding model used by
 * ranked memory recall (pkg/rancher-desktop/agent/memory/). Pinned to an exact
 * Hugging Face revision + sha256 so builds are reproducible.
 *
 * The 129 MB float32 table is converted to int8 with a per-row scale (~33 MB);
 * the lab measured no recall loss from this quantization. Output lands in
 * resources/models/potion-retrieval-32M/, which electron-builder ships via
 * `extraResources: - resources/`.
 */
const REPO = 'minishlab/potion-retrieval-32M';
const REVISION = '6fc8051fab2a1e0ee76689cf08c853792ac285e7';
const FILES = {
  'model.safetensors': '07609e5bd33aad37900b3fd62f4ec96f6daec88ca4d46b9d8b928bfababf6ea0',
  'tokenizer.json':    '7d75cbc54318138807c401b0f0c9721117c628b39de8e8e0edb6cb17e0ee7d18',
} as const;

export const POTION_MODEL_DIRNAME = path.join('models', 'potion-retrieval-32M');

function fileUrl(name: string): string {
  return `https://huggingface.co/${ REPO }/resolve/${ REVISION }/${ name }`;
}

export class PotionRetrievalModel implements Dependency {
  readonly name = 'potionRetrievalModel';

  async download(context: DownloadContext): Promise<void> {
    const destDir = path.join(context.resourcesDir, POTION_MODEL_DIRNAME);
    const binPath = path.join(destDir, 'model.int8.bin');
    const stampPath = path.join(destDir, 'REVISION');

    if (fs.existsSync(binPath) && fs.existsSync(stampPath) && fs.readFileSync(stampPath, 'utf8').trim() === REVISION) {
      console.log(`[potion] ${ REPO }@${ REVISION.slice(0, 7) } already present, skipping`);

      return;
    }
    await fs.promises.mkdir(destDir, { recursive: true });
    await download(fileUrl('tokenizer.json'), path.join(destDir, 'tokenizer.json'), {
      expectedChecksum: FILES['tokenizer.json'], access: fs.constants.W_OK, overwrite: true,
    });

    const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'potion-'));
    const tablePath = path.join(tmpDir, 'model.safetensors');

    try {
      await download(fileUrl('model.safetensors'), tablePath, {
        expectedChecksum: FILES['model.safetensors'], access: fs.constants.W_OK, overwrite: true,
      });
      const { rows, dim } = convertSafetensorsToInt8(tablePath, binPath);

      console.log(`[potion] converted ${ rows }×${ dim } table to int8 → ${ binPath }`);
    } finally {
      await fs.promises.rm(tmpDir, { recursive: true, force: true });
    }
    await fs.promises.writeFile(path.join(destDir, 'LICENSE'), [
      `${ REPO } (revision ${ REVISION })`,
      `https://huggingface.co/${ REPO }`,
      'Licensed under the MIT License (declared in the upstream model card).',
      'Redistributed in int8-quantized form for on-device memory recall.',
      '',
    ].join('\n'));
    await fs.promises.writeFile(stampPath, `${ REVISION }\n`);
  }
}
