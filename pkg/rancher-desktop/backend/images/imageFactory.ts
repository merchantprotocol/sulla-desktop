import { VMBackend } from '@pkg/backend/backend';
import { ImageProcessor } from '@pkg/backend/images/imageProcessor';
import MobyImageProcessor from '@pkg/backend/images/mobyImageProcessor';
import { ContainerEngine } from '@pkg/config/settings';

const cachedImageProcessors: Partial<Record<ContainerEngine, ImageProcessor>> = { };

/**
 * Return the ImageProcessor singleton for the specified ContainerEngine.
 * The Sulla runtime always runs dockerd, so every engine uses the moby processor.
 */
export function getImageProcessor(engineName: ContainerEngine, executor: VMBackend): ImageProcessor {
  cachedImageProcessors[engineName] ??= new MobyImageProcessor(executor);

  return cachedImageProcessors[engineName];
}
