import * as fs from 'node:fs';
import * as path from 'node:path';

const DISPLAY_LABEL_LENGTH = 32;

function boundedLabel(value: string, fallback: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, DISPLAY_LABEL_LENGTH) || fallback;
}

export function isolatedCheckoutPrefix(repository: string, branch: string, jobKey: string): string {
  return `${ boundedLabel(repository, 'repository') }-${ boundedLabel(branch, 'detached') }-agent-${ boundedLabel(jobKey, 'job') }-`;
}

export async function createIsolatedCheckout(
  worktreeRoot: string,
  prefix: string,
  clone: (checkout: string) => Promise<void>,
): Promise<string> {
  const checkout = fs.mkdtempSync(path.join(worktreeRoot, prefix));

  try {
    await clone(checkout);
    return checkout;
  } catch (error) {
    try {
      fs.rmSync(checkout, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], `Failed to clone and clean isolated checkout ${ checkout }`);
    }
    throw error;
  }
}
