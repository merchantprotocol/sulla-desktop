import fs from 'fs';
import path from 'path';

export type SullaServiceImageName = 'sulla-agent' | 'sulla-vault' | 'sulla-workflows';

export interface SullaServiceImage {
  build?: {
    context:    string;
    dockerfile: string;
  };
  image: string;
}

function publishedTag(appVersion: string): string {
  const version = appVersion.trim().replace(/^v/, '');
  const developmentCommit = /(?:^|-)dev\.([0-9a-f]{7,40})(?:$|[.+-])/i.exec(version)?.[1];

  if (developmentCommit) {
    return `sha-${ developmentCommit.slice(0, 7).toLowerCase() }`;
  }
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    return version;
  }

  return 'latest';
}

export function resolveSullaServiceImage(
  name: SullaServiceImageName,
  sourceRoot: string,
  appVersion: string,
  override?: string,
  fileExists: typeof fs.existsSync = fs.existsSync,
): SullaServiceImage {
  const dockerfile = path.join('services', name, 'Dockerfile');

  if (fileExists(path.join(sourceRoot, dockerfile))) {
    return {
      build: { context: sourceRoot, dockerfile },
      image: `${ name }:local`,
    };
  }

  return { image: override || `ghcr.io/merchantprotocol/${ name }:${ publishedTag(appVersion) }` };
}
